using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;
using System.Drawing;
using System.Drawing.Text;

namespace WhereMyTokens.Taskbar;

internal static class Program
{
    private static readonly HashSet<string> ValidTaskbarPeriods = new(StringComparer.Ordinal) { "5h", "7d" };
    private static readonly HashSet<string> ValidQuotaSeverities = new(StringComparer.Ordinal) { "normal", "warning", "danger", "unknown" };
    private static readonly HashSet<string> ValidProviderStatusTones = new(StringComparer.Ordinal) { "normal", "warning", "danger", "unknown" };
    private static readonly HashSet<string> ValidQuotaStates = new(StringComparer.Ordinal) { "limited", "unlimited" };

    [STAThread]
    private static void Main()
    {
        // RID 지정 publish에서 MSBuild DPI 속성이 빠질 수 있어, 실제 배포 산출물에서도
        // PerMonitorV2가 확실히 적용되도록 API를 직접 호출한다.
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        ApplicationConfiguration.Initialize();
        using var form = new TaskbarQuotaForm();
        if (!form.AttachToTaskbar())
        {
            Environment.ExitCode = 2;
            return;
        }

        _ = Task.Run(() => ReadSnapshots(form));
        Application.Run(form);
    }

    private static async Task ReadSnapshots(TaskbarQuotaForm form)
    {
        while (await Console.In.ReadLineAsync() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var snapshot = JsonSerializer.Deserialize<TaskbarQuotaSnapshot>(line, JsonOptions.Value);
                if (snapshot is null || !IsValidSnapshot(snapshot))
                {
                    WriteEvent("snapshot-rejected");
                    continue;
                }
                form.BeginInvoke(() =>
                {
                    try
                    {
                        form.Render(snapshot);
                        WriteEvent("snapshot-rendered");
                    }
                    catch
                    {
                        Environment.ExitCode = 3;
                        Application.Exit();
                    }
                });
            }
            catch
            {
                WriteEvent("snapshot-rejected");
                // 잘못된 입력은 WMT를 죽이지 않고 다음 snapshot을 기다린다.
            }
        }

        form.BeginInvoke(Application.Exit);
    }

    private static bool IsValidSnapshot(TaskbarQuotaSnapshot snapshot)
    {
        if (snapshot.Lines is not { Length: 2 }) return false;
        foreach (var row in snapshot.Lines)
        {
            if (row is null
                || !ValidTaskbarPeriods.Contains(row.Period)
                || (row.Label != "5h" && row.Label != "1w")
                || row.Blocks is null
                || row.Blocks.Length > 3
                || row.HiddenCount < 0)
            {
                return false;
            }
            foreach (var block in row.Blocks)
            {
                if (block is null
                    || string.IsNullOrWhiteSpace(block.TargetId)
                    || string.IsNullOrWhiteSpace(block.Provider)
                    || string.IsNullOrWhiteSpace(block.Abbreviation)
                    || string.IsNullOrWhiteSpace(block.Label)
                    || !ValidQuotaStates.Contains(block.State)
                    || (block.State == "limited" && (block.UsedPct is null or < 0 or > 100))
                    || (block.State == "unlimited" && block.UsedPct is not null)
                    || block.ElapsedPct is < 0 or > 100
                    || !ValidQuotaSeverities.Contains(block.Severity)
                    || !ValidProviderStatusTones.Contains(block.ProviderStatusTone))
                {
                    return false;
                }
            }
        }
        return true;
    }

    internal static void WriteEvent(string type)
    {
        try
        {
            Console.Out.WriteLine($"{{\"type\":\"{type}\"}}");
            Console.Out.Flush();
        }
        catch
        {
            // stdout 보고 실패는 helper 렌더링 자체를 막지 않는다.
        }
    }
}

internal sealed class TaskbarQuotaForm : Form
{
    private const int DefaultPreferredWidth = 520;
    private const int MinimumScreenAwareWidth = 360;
    private const int MaximumPreferredWidth = 920;
    private const int HorizontalHeightPadding = 4;
    private const int VerticalWidthPadding = 8;
    private const int DefaultRightReserve = 620;
    // TransparencyKey는 정확히 일치하는 픽셀만 뚫기 때문에, 실제 taskbar 배경에 가까운 색을 키로 잡아
    // 안티앨리어싱된 글자 가장자리의 잔여 색이 배경에 자연스럽게 묻히도록 한다.
    private static readonly Color DarkTransparentKey = Color.FromArgb(16, 16, 18);
    private static readonly Color LightTransparentKey = Color.FromArgb(248, 248, 249);
    private static readonly string LayoutStatePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "WhereMyTokens",
        "TaskbarHelper",
        "layout.json");
    private readonly TaskbarQuotaCanvas _canvas = new() { Dock = DockStyle.Fill };
    private Size _taskbarClientSize = Size.Empty;
    private float _dpiScale = 1f;
    private Color TransparentKey { get; set; } = DarkTransparentKey;
    private bool _dragging;
    private bool _movedDuringDrag;
    private bool _suppressNextClick;
    private Point _dragStartMouse;
    private Point _dragStartLocation;

    public TaskbarQuotaForm()
    {
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        ApplyTransparentKey(isLight: false);
        Width = DefaultPreferredWidth;
        Height = 56;
        Cursor = Cursors.SizeAll;
        DoubleBuffered = true;
        Controls.Add(_canvas);

        WireInteractive(this);
        WireInteractive(_canvas);
    }

    private void ApplyTransparentKey(bool isLight)
    {
        TransparentKey = isLight ? LightTransparentKey : DarkTransparentKey;
        BackColor = TransparentKey;
        TransparencyKey = TransparentKey;
        _canvas.BackColor = TransparentKey;
        _canvas.TransparentKey = TransparentKey;
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
            cp.ExStyle &= ~Native.WS_EX_APPWINDOW;
            return cp;
        }
    }

    public bool AttachToTaskbar()
    {
        if (!RefreshTaskbarMetrics()) return false;

        var bounds = LayoutBounds(
            _taskbarClientSize.Width,
            _taskbarClientSize.Height,
            LoadLayoutState(),
            PreferredWidthForTaskbar(_taskbarClientSize.Width, Scaled(DefaultPreferredWidth)));

        Native.MoveWindow(Handle, bounds.X, bounds.Y, bounds.Width, bounds.Height, true);
        Show();
        return true;
    }

    private bool RefreshTaskbarMetrics()
    {
        var taskbar = Native.FindWindow("Shell_TrayWnd", null);
        if (taskbar == IntPtr.Zero) return false;
        if (!Native.GetClientRect(taskbar, out var rect)) return false;
        if (rect.Right <= 0 || rect.Bottom <= 0) return false;

        var dpi = Native.GetDpiForWindow(taskbar);
        _dpiScale = dpi > 0 ? dpi / 96f : 1f;
        _canvas.DpiScale = _dpiScale;

        Native.SetParent(Handle, taskbar);
        var taskbarWidth = rect.Right - rect.Left;
        var taskbarHeight = rect.Bottom - rect.Top;
        _taskbarClientSize = new Size(taskbarWidth, taskbarHeight);
        return true;
    }

    // 아래 pixel budget은 96-DPI 기준 논리값이며, Scaled()가 taskbar monitor DPI에 맞춰 장치 pixel로 변환한다.
    private int Scaled(int value) => Math.Max(0, (int)Math.Round(value * _dpiScale));

    private Rectangle LayoutBounds(int taskbarWidth, int taskbarHeight, LayoutState? saved, int preferredWidth)
    {
        var horizontal = taskbarWidth >= taskbarHeight;
        var width = horizontal
            ? Math.Min(preferredWidth, Math.Max(Scaled(160), taskbarWidth - Scaled(8)))
            : Math.Max(Scaled(96), taskbarWidth - Scaled(VerticalWidthPadding));
        var height = horizontal
            ? Math.Min(taskbarHeight, Math.Max(Scaled(48), taskbarHeight - Scaled(HorizontalHeightPadding)))
            : Math.Min(Math.Max(Scaled(48), taskbarHeight / 5), Math.Max(Scaled(48), taskbarHeight - Scaled(8)));
        var defaultX = horizontal ? Math.Max(0, taskbarWidth - width - Scaled(DefaultRightReserve)) : Math.Max(0, (taskbarWidth - width) / 2);
        var defaultY = horizontal ? Math.Max(0, (taskbarHeight - height) / 2) : Math.Max(0, taskbarHeight - height - Scaled(160));
        var x = saved?.X ?? defaultX;
        var y = saved?.Y ?? defaultY;
        var point = ClampLocation(new Point(x, y), new Size(width, height), new Size(taskbarWidth, taskbarHeight));
        return new Rectangle(point, new Size(width, height));
    }

    private int PreferredWidthForTaskbar(int taskbarWidth, int preferredContentWidth)
    {
        var taskbarLimit = Math.Max(Scaled(160), taskbarWidth - Scaled(8));
        var screenAwareLimit = Math.Min(Scaled(MaximumPreferredWidth), Math.Max(Scaled(MinimumScreenAwareWidth), taskbarWidth / 2));
        return Math.Min(taskbarLimit, Math.Min(screenAwareLimit, preferredContentWidth));
    }

    public void Render(TaskbarQuotaSnapshot snapshot)
    {
        ResizeToSnapshot(snapshot);
        var isLight = SampleBackgroundIsLight() ?? FallbackThemeIsLight(snapshot.Theme);
        ApplyTransparentKey(isLight);
        _canvas.Render(snapshot, isLight);
    }

    private void ResizeToSnapshot(TaskbarQuotaSnapshot snapshot)
    {
        if (!RefreshTaskbarMetrics()) return;
        if (_taskbarClientSize.IsEmpty) return;

        var taskbarWidth = _taskbarClientSize.Width;
        var taskbarHeight = _taskbarClientSize.Height;
        var preferredContentWidth = _canvas.MeasurePreferredWidth(snapshot, taskbarWidth);
        var bounds = LayoutBounds(
            taskbarWidth,
            taskbarHeight,
            LoadLayoutState(),
            PreferredWidthForTaskbar(taskbarWidth, preferredContentWidth));
        if (bounds.Location == Location && bounds.Size == Size) return;

        Native.MoveWindow(Handle, bounds.X, bounds.Y, bounds.Width, bounds.Height, true);
    }

    private void WireInteractive(Control control)
    {
        control.Click += OnOpenDashboard;
        control.MouseDown += BeginDrag;
        control.MouseMove += DragMove;
        control.MouseUp += EndDrag;
        control.Cursor = Cursors.SizeAll;
    }

    private void BeginDrag(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _dragging = true;
        _movedDuringDrag = false;
        _dragStartMouse = Control.MousePosition;
        _dragStartLocation = Location;
        Capture = true;
    }

    private void DragMove(object? sender, MouseEventArgs e)
    {
        if (!_dragging || _taskbarClientSize.IsEmpty) return;
        var current = Control.MousePosition;
        var delta = new Size(current.X - _dragStartMouse.X, current.Y - _dragStartMouse.Y);
        if (Math.Abs(delta.Width) + Math.Abs(delta.Height) > 3) _movedDuringDrag = true;
        var next = ClampLocation(_dragStartLocation + delta, Size, _taskbarClientSize);
        Native.MoveWindow(Handle, next.X, next.Y, Width, Height, true);
    }

    private void EndDrag(object? sender, MouseEventArgs e)
    {
        if (!_dragging) return;
        _dragging = false;
        Capture = false;
        _suppressNextClick = _movedDuringDrag;
        if (_movedDuringDrag)
        {
            SaveLayoutState(new LayoutState(Location.X, Location.Y));
            var isLight = SampleBackgroundIsLight() ?? _canvas.BackgroundIsLight;
            ApplyTransparentKey(isLight);
            _canvas.ApplyPalette(isLight);
        }
    }

    private void OnOpenDashboard(object? sender, EventArgs e)
    {
        if (_suppressNextClick)
        {
            _suppressNextClick = false;
            return;
        }
        Program.WriteEvent("open-dashboard");
    }

    private static Point ClampLocation(Point point, Size formSize, Size taskbarSize)
    {
        var maxX = Math.Max(0, taskbarSize.Width - formSize.Width);
        var maxY = Math.Max(0, taskbarSize.Height - formSize.Height);
        return new Point(Math.Clamp(point.X, 0, maxX), Math.Clamp(point.Y, 0, maxY));
    }

    private bool? SampleBackgroundIsLight()
    {
        try
        {
            var bounds = RectangleToScreen(ClientRectangle);
            if (bounds.Width <= 0 || bounds.Height <= 0) return null;
            var sampleSize = new Size(Math.Min(48, bounds.Width), Math.Min(24, bounds.Height));
            var sampleX = bounds.Left + Math.Max(0, (bounds.Width - sampleSize.Width) / 2);
            var sampleY = bounds.Top + Math.Max(0, (bounds.Height - sampleSize.Height) / 2);
            using var bitmap = new Bitmap(sampleSize.Width, sampleSize.Height);
            using var graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(sampleX, sampleY, 0, 0, sampleSize);
            var total = 0d;
            var count = 0;
            for (var y = 0; y < bitmap.Height; y += 4)
            {
                for (var x = 0; x < bitmap.Width; x += 4)
                {
                    total += RelativeLuminance(bitmap.GetPixel(x, y));
                    count += 1;
                }
            }
            return count > 0 ? total / count > 0.55 : null;
        }
        catch
        {
            return null;
        }
    }

    private static double RelativeLuminance(Color color)
    {
        static double Linear(byte channel)
        {
            var value = channel / 255d;
            return value <= 0.03928 ? value / 12.92 : Math.Pow((value + 0.055) / 1.055, 2.4);
        }

        return 0.2126 * Linear(color.R) + 0.7152 * Linear(color.G) + 0.0722 * Linear(color.B);
    }

    private static bool FallbackThemeIsLight(string? theme) => theme == "light";

    private static LayoutState? LoadLayoutState()
    {
        try
        {
            if (!File.Exists(LayoutStatePath)) return null;
            return JsonSerializer.Deserialize<LayoutState>(File.ReadAllText(LayoutStatePath), JsonOptions.Value);
        }
        catch
        {
            return null;
        }
    }

    private static void SaveLayoutState(LayoutState state)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LayoutStatePath)!);
            File.WriteAllText(LayoutStatePath, JsonSerializer.Serialize(state), System.Text.Encoding.UTF8);
        }
        catch
        {
            // 위치 저장 실패는 taskbar helper 동작에 영향을 주지 않아야 한다.
        }
    }
}

internal static class JsonOptions
{
    public static readonly JsonSerializerOptions Value = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.Strict,
    };
}

internal sealed record TaskbarQuotaSnapshot(long UpdatedAt, string? Theme, TaskbarQuotaDisplayLine[] Lines);
internal sealed record TaskbarQuotaDisplayLine(string Period, string Label, TaskbarQuotaBlock[] Blocks, int HiddenCount = 0);
internal sealed record LayoutState(int X, int Y);
internal sealed record TaskbarQuotaBlock(
    string TargetId,
    string Provider,
    string Abbreviation,
    string Label,
    string State,
    double? UsedPct,
    double? ElapsedPct,
    bool DurationInferred,
    string? ResetLabel,
    string ProviderStatusTone,
    string Severity);

internal sealed class TaskbarQuotaCanvas : Control
{
    private const int DividerWidth = 1;
    private const int PeriodColumn = 0;
    private const int BlockOneColumn = 1;
    private const int BlockTwoColumn = 2;
    private const int BlockThreeColumn = 3;
    private const int BlockGap = 6;
    private const int HorizontalPadding = 4;
    private const int VerticalPadding = 2;
    private const int PeriodWidth = 32;
    private const int BlockHorizontalPadding = 2;
    private const int OverflowBadgeHorizontalPadding = 1;
    private const int MinimumBlockWidth = 112;
    private const int MinimumMaximumBlockWidth = 124;
    private const int MaximumMaximumBlockWidth = 260;
    private readonly Font _periodFont = new("Segoe UI", 9.25f, FontStyle.Regular);
    private readonly Font _blockFont = new("Segoe UI", 9.0f, FontStyle.Regular);
    private TaskbarQuotaSnapshot? _snapshot;
    private Palette _palette = Palette.SubduedDark;

    public bool BackgroundIsLight { get; private set; }

    /// <summary>소유 form이 설정하는 taskbar monitor의 장치 pixel 배율(1f = 96 DPI).</summary>
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    [System.ComponentModel.Browsable(false)]
    public float DpiScale { get; set; } = 1f;

    /// <summary>소유 form의 TransparencyKey/BackColor와 동기화되는 현재 color-key 값.</summary>
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    [System.ComponentModel.Browsable(false)]
    public Color TransparentKey { get; set; } = Color.FromArgb(16, 16, 18);

    private int Scaled(int value) => Math.Max(1, (int)Math.Round(value * DpiScale));

    private int RowHeight => Math.Max(Scaled(18), (ClientSize.Height - (Scaled(VerticalPadding) * 2)) / 2);
    public TaskbarQuotaCanvas()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw |
            ControlStyles.UserPaint,
            true);
        BackColor = TransparentKey;
        DoubleBuffered = true;
    }

    public void Render(TaskbarQuotaSnapshot snapshot, bool backgroundIsLight)
    {
        _snapshot = snapshot;
        ApplyPalette(backgroundIsLight);
    }

    public int MeasurePreferredWidth(TaskbarQuotaSnapshot snapshot, int taskbarWidth)
    {
        using var graphics = CreateGraphics();
        var maxBlockWidth = MaximumBlockWidthFor(taskbarWidth, VisibleQuotaBlockCount(snapshot));
        var blockWidths = MeasureColumnWidths(graphics, snapshot, maxBlockWidth);
        return (Scaled(HorizontalPadding) * 2) + MeasureContentWidth(blockWidths);
    }

    public void ApplyPalette(bool backgroundIsLight)
    {
        BackgroundIsLight = backgroundIsLight;
        _palette = backgroundIsLight ? Palette.SubduedLight : Palette.SubduedDark;
        Invalidate();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _periodFont.Dispose();
            _blockFont.Dispose();
        }
        base.Dispose(disposing);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        e.Graphics.Clear(TransparentKey);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(TransparentKey);
        e.Graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        var snapshot = _snapshot;
        if (snapshot is null) return;

        var content = Rectangle.Inflate(ClientRectangle, -Scaled(HorizontalPadding), -Scaled(VerticalPadding));
        if (content.Width <= 0 || content.Height <= 0) return;

        var columns = ComputeColumns(e.Graphics, content, snapshot);
        DrawDivider(e.Graphics, columns.PeriodDivider);
        if (columns[BlockTwoColumn].Width > 0) DrawDivider(e.Graphics, columns.BlockOneDivider);
        if (columns[BlockThreeColumn].Width > 0) DrawDivider(e.Graphics, columns.BlockTwoDivider);

        for (var index = 0; index < Math.Min(2, snapshot.Lines.Length); index++)
        {
            var rowBounds = new Rectangle(content.Left, content.Top + (index * RowHeight), content.Width, RowHeight);
            DrawRow(e.Graphics, snapshot.Lines[index], columns, rowBounds);
        }
    }

    private ColumnLayout ComputeColumns(Graphics graphics, Rectangle content, TaskbarQuotaSnapshot snapshot)
    {
        var period = new Rectangle(content.Left, content.Top, Scaled(PeriodWidth), content.Height);
        var periodDivider = new Rectangle(period.Right, content.Top, Scaled(DividerWidth), content.Height);

        var blockWidths = FitBlockWidths(MeasureColumnWidths(graphics, snapshot, MaximumBlockWidthFor(ClientSize.Width, VisibleQuotaBlockCount(snapshot))), content.Width);
        var blockOneWidth = blockWidths[0];
        var blockTwoWidth = blockWidths[1];
        var blockThreeWidth = blockWidths[2];
        var x = periodDivider.Right + Scaled(BlockGap);
        var blockOne = new Rectangle(x, content.Top, blockOneWidth, content.Height);
        var blockOneDivider = new Rectangle(blockOne.Right + (Scaled(BlockGap) / 2), content.Top, Scaled(DividerWidth), content.Height);
        x = blockOneDivider.Right + Scaled(BlockGap);
        var blockTwo = new Rectangle(x, content.Top, blockTwoWidth, content.Height);
        var blockTwoDivider = new Rectangle(blockTwo.Right + (Scaled(BlockGap) / 2), content.Top, Scaled(DividerWidth), content.Height);
        x = blockTwoDivider.Right + Scaled(BlockGap);
        var blockThree = new Rectangle(x, content.Top, blockThreeWidth, content.Height);

        return new ColumnLayout(
            new[] { period, blockOne, blockTwo, blockThree },
            periodDivider,
            blockOneDivider,
            blockTwoDivider);
    }

    private int[] MeasureColumnWidths(Graphics graphics, TaskbarQuotaSnapshot snapshot, int maxBlockWidth)
        => new[]
        {
            MeasureColumnWidth(graphics, snapshot, 0, maxBlockWidth),
            MeasureColumnWidth(graphics, snapshot, 1, maxBlockWidth),
            MeasureColumnWidth(graphics, snapshot, 2, maxBlockWidth),
        };

    private int[] FitBlockWidths(IReadOnlyList<int> measured, int contentWidth)
    {
        var widths = measured.Take(3).ToArray();
        if (MeasureContentWidth(widths) <= contentWidth) return widths;

        var visibleCount = 0;
        for (var index = 0; index < widths.Length; index++)
        {
            if (widths[index] <= 0) break;
            visibleCount += 1;
        }
        if (visibleCount == 0) return widths;

        var availableForBlocks = Math.Max(0, contentWidth - NonBlockWidthForBlockCount(visibleCount));
        var fittedWidth = availableForBlocks / visibleCount;
        for (var index = 0; index < visibleCount; index++)
        {
            widths[index] = Math.Min(widths[index], fittedWidth);
        }
        return widths;
    }

    private int NonBlockWidthForBlockCount(int blockCount)
    {
        var width = Scaled(PeriodWidth) + Scaled(DividerWidth);
        if (blockCount <= 0) return width;
        width += Scaled(BlockGap);
        for (var index = 1; index < blockCount; index++)
        {
            width += (Scaled(BlockGap) / 2) + Scaled(DividerWidth) + Scaled(BlockGap);
        }
        return width;
    }

    private int MeasureColumnWidth(Graphics graphics, TaskbarQuotaSnapshot snapshot, int blockIndex, int maxBlockWidth)
    {
        var width = 0;
        var hasQuotaBlock = false;
        foreach (var row in snapshot.Lines.Take(2))
        {
            var block = row.Blocks.ElementAtOrDefault(blockIndex);
            if (block is not null)
            {
                hasQuotaBlock = true;
                var blockWidth = MeasureBlockWidth(graphics, block, maxBlockWidth);
                if (row.HiddenCount > 0 && blockIndex == 2)
                {
                    blockWidth = Math.Min(maxBlockWidth, blockWidth + MeasureOverflowBadgeWidth(graphics, row.HiddenCount));
                }
                width = Math.Max(width, blockWidth);
                continue;
            }
            if (row.HiddenCount > 0 && blockIndex == row.Blocks.Length && blockIndex < 3)
            {
                width = Math.Max(width, MeasureOverflowBadgeWidth(graphics, row.HiddenCount));
            }
        }
        if (width <= 0) return 0;
        return FinalizeMeasuredColumnWidth(width, hasQuotaBlock, maxBlockWidth);
    }

    private int FinalizeMeasuredColumnWidth(int measuredWidth, bool hasQuotaBlock, int maxBlockWidth)
    {
        var minimumWidth = hasQuotaBlock ? Scaled(MinimumBlockWidth) : 0;
        return Math.Min(maxBlockWidth, Math.Max(minimumWidth, measuredWidth));
    }

    private int MeasureOverflowBadgeWidth(Graphics graphics, int hiddenCount)
    {
        var textWidth = MeasureDrawStringWidth(graphics, $"+{hiddenCount}", _blockFont, Scaled(MaximumMaximumBlockWidth));
        return textWidth + (Scaled(OverflowBadgeHorizontalPadding) * 2);
    }

    private int MeasureBlockWidth(Graphics graphics, TaskbarQuotaBlock? block, int maxBlockWidth)
    {
        if (block is null) return Scaled(MinimumBlockWidth);
        var measured = MeasureBlockContentWidth(graphics, block, maxBlockWidth);
        return Math.Min(maxBlockWidth, measured + (Scaled(BlockHorizontalPadding) * 2));
    }

    private int MeasureBlockContentWidth(Graphics graphics, TaskbarQuotaBlock block, int maxBlockWidth)
    {
        var width = 0;
        foreach (var text in new[]
        {
            QuotaPrefixLabel(block),
            QuotaUsedText(block),
            ElapsedText(block),
            ResetText(block),
        })
        {
            width += MeasureDrawStringWidth(graphics, text, _blockFont, Math.Max(0, maxBlockWidth - width));
            if (width >= maxBlockWidth) return maxBlockWidth;
        }
        return width;
    }

    private static int VisibleQuotaBlockCount(TaskbarQuotaSnapshot snapshot)
        => Math.Clamp(snapshot.Lines.Take(2).Select(row => Math.Min(3, row.Blocks.Length)).DefaultIfEmpty(0).Max(), 1, 3);

    private int MaximumBlockWidthFor(int availableWidth, int visibleBlockCount)
    {
        var contentWidth = Math.Max(0, availableWidth - (Scaled(HorizontalPadding) * 2));
        var blockCount = Math.Clamp(visibleBlockCount, 1, 3);
        var nonBlockWidth = NonBlockWidthForBlockCount(blockCount);
        return Math.Clamp((contentWidth - nonBlockWidth) / blockCount, Scaled(MinimumMaximumBlockWidth), Scaled(MaximumMaximumBlockWidth));
    }

    private int MeasureContentWidth(IReadOnlyList<int> blockWidths)
    {
        var width = Scaled(PeriodWidth) + Scaled(DividerWidth);
        if (blockWidths.Count == 0 || blockWidths[0] <= 0) return width;

        width += Scaled(BlockGap) + blockWidths[0];
        for (var index = 1; index < Math.Min(3, blockWidths.Count); index++)
        {
            if (blockWidths[index] <= 0) break;
            width += (Scaled(BlockGap) / 2) + Scaled(DividerWidth) + Scaled(BlockGap) + blockWidths[index];
        }
        return width;
    }

    private void DrawRow(Graphics graphics, TaskbarQuotaDisplayLine row, ColumnLayout columns, Rectangle rowBounds)
    {
        DrawText(graphics, row.Label, _periodFont, _palette.Text, RowCell(columns[PeriodColumn], rowBounds));
        if (row.Blocks.Length == 0) return;
        DrawBlock(graphics, row.Blocks.ElementAtOrDefault(0), RowCell(columns[BlockOneColumn], rowBounds));
        DrawBlock(graphics, row.Blocks.ElementAtOrDefault(1), RowCell(columns[BlockTwoColumn], rowBounds));
        var thirdCell = RowCell(columns[BlockThreeColumn], rowBounds);
        if (row.HiddenCount > 0 && row.Blocks.Length < 3)
        {
            var badgeColumn = row.Blocks.Length == 1 ? BlockTwoColumn : BlockThreeColumn;
            DrawOverflowBadge(graphics, row.HiddenCount, RowCell(columns[badgeColumn], rowBounds));
            return;
        }
        if (row.HiddenCount > 0 && thirdCell.Width > 0)
        {
            var badgeWidth = Math.Min(MeasureOverflowBadgeWidth(graphics, row.HiddenCount), thirdCell.Width);
            var blockCell = new Rectangle(thirdCell.Left, thirdCell.Top, Math.Max(0, thirdCell.Width - badgeWidth), thirdCell.Height);
            var badgeCell = new Rectangle(thirdCell.Right - badgeWidth, thirdCell.Top, badgeWidth, thirdCell.Height);
            DrawBlock(graphics, row.Blocks.ElementAtOrDefault(2), blockCell);
            DrawOverflowBadge(graphics, row.HiddenCount, badgeCell);
            return;
        }
        DrawBlock(graphics, row.Blocks.ElementAtOrDefault(2), thirdCell);
    }

    private void DrawBlock(Graphics graphics, TaskbarQuotaBlock? block, Rectangle bounds)
    {
        if (block is null || bounds.Width <= 0) return;

        var cursor = bounds.Left + Scaled(BlockHorizontalPadding);
        var prefixText = QuotaPrefixLabel(block);
        var quotaUsedText = QuotaUsedText(block);
        var elapsedText = ElapsedText(block);
        var resetText = ResetText(block);
        var prefixWidth = DrawMeasuredText(
            graphics,
            prefixText,
            _blockFont,
            ProviderStatusColorFor(block.ProviderStatusTone),
            new Rectangle(cursor, bounds.Top, Math.Max(0, bounds.Right - cursor), bounds.Height));
        cursor += prefixWidth;
        var quotaWidth = DrawMeasuredText(
            graphics,
            quotaUsedText,
            _blockFont,
            QuotaColorFor(block.Severity),
            new Rectangle(cursor, bounds.Top, Math.Max(0, bounds.Right - cursor), bounds.Height));
        cursor += quotaWidth;
        var elapsedWidth = DrawMeasuredText(
            graphics,
            elapsedText,
            _blockFont,
            _palette.Text,
            new Rectangle(cursor, bounds.Top, Math.Max(0, bounds.Right - cursor), bounds.Height));
        cursor += elapsedWidth;
        if (cursor < bounds.Right)
        {
            var resetWidth = DrawMeasuredText(
                graphics,
                resetText,
                _blockFont,
                _palette.Text,
                new Rectangle(cursor, bounds.Top, Math.Max(0, bounds.Right - cursor), bounds.Height));
            cursor += resetWidth;
        }
    }

    private int DrawMeasuredText(Graphics graphics, string text, Font font, Color color, Rectangle bounds)
    {
        if (bounds.Width <= 0) return 0;
        var measured = MeasureDrawStringWidth(graphics, text, font, bounds.Width);
        DrawText(graphics, text, font, color, new Rectangle(bounds.Left, bounds.Top, measured, bounds.Height));
        return measured;
    }

    private int MeasureDrawStringWidth(Graphics graphics, string text, Font font, int maxWidth)
    {
        if (string.IsNullOrEmpty(text) || maxWidth <= 0) return 0;
        using var format = TextStringFormat();
        var measured = graphics.MeasureString(text, font, maxWidth, format);
        return Math.Min(maxWidth, (int)Math.Ceiling(measured.Width) + Scaled(2));
    }

    private void DrawText(Graphics graphics, string text, Font font, Color color, Rectangle bounds)
    {
        if (bounds.Width <= 0 || bounds.Height <= 0 || string.IsNullOrEmpty(text)) return;
        using var brush = new SolidBrush(color);
        using var format = TextStringFormat();
        graphics.DrawString(text, font, brush, bounds, format);
    }

    private void DrawDivider(Graphics graphics, Rectangle bounds)
    {
        if (bounds.Width <= 0 || bounds.Height <= 0) return;
        using var brush = new SolidBrush(_palette.Divider);
        graphics.FillRectangle(brush, bounds);
    }

    private void DrawOverflowBadge(Graphics graphics, int hiddenCount, Rectangle bounds)
    {
        if (hiddenCount <= 0 || bounds.Width <= 0 || bounds.Height <= 0) return;
        var horizontalPadding = Math.Min(Scaled(OverflowBadgeHorizontalPadding), bounds.Width / 2);
        var contentBounds = Rectangle.Inflate(bounds, -horizontalPadding, 0);
        DrawText(graphics, $"+{hiddenCount}", _blockFont, _palette.Muted, contentBounds);
    }

    private Rectangle RowCell(Rectangle column, Rectangle rowBounds)
    {
        var top = rowBounds.Top;
        var height = Math.Min(RowHeight, rowBounds.Height);
        return new Rectangle(column.Left, top, column.Width, height);
    }

    private static string QuotaPrefixLabel(TaskbarQuotaBlock block) => $"{block.Abbreviation}:";

    private static string QuotaUsedText(TaskbarQuotaBlock block)
        => block.State == "unlimited" ? "∞" : PctText(block.UsedPct);

    private static string ElapsedText(TaskbarQuotaBlock block)
        => block.ElapsedPct is null ? "" : $"/{(block.DurationInferred ? "~" : "")}{PctText(block.ElapsedPct)}";

    private static string ResetText(TaskbarQuotaBlock block) => string.IsNullOrWhiteSpace(block.ResetLabel) ? "" : $" {block.ResetLabel}";

    private static string PctText(double? value) => value is null ? "" : $"{Math.Round(value.Value):0}%";

    private Color QuotaColorFor(string severity) => severity switch
    {
        "danger" => _palette.Danger,
        "warning" => _palette.Warning,
        "unknown" => _palette.Unknown,
        _ => _palette.Normal,
    };

    private Color ProviderStatusColorFor(string tone) => tone switch
    {
        "danger" => _palette.Danger,
        "warning" => _palette.Warning,
        "unknown" => _palette.Muted,
        _ => _palette.Text,
    };

    private static StringFormat TextStringFormat() => new()
    {
        Alignment = StringAlignment.Near,
        LineAlignment = StringAlignment.Center,
        FormatFlags = StringFormatFlags.NoWrap,
        Trimming = StringTrimming.EllipsisCharacter,
    };

    private readonly record struct ColumnLayout(
        Rectangle[] Columns,
        Rectangle PeriodDivider,
        Rectangle BlockOneDivider,
        Rectangle BlockTwoDivider)
    {
        public Rectangle this[int column] => Columns[column];
    }

    private sealed record Palette(
        Color Text,
        Color Muted,
        Color Divider,
        Color Normal,
        Color Warning,
        Color Danger,
        Color Unknown)
    {
        public static readonly Palette SubduedLight = new(
            ColorTranslator.FromHtml("#111827"),
            ColorTranslator.FromHtml("#4b5563"),
            ColorTranslator.FromHtml("#9ca3af"),
            ColorTranslator.FromHtml("#2f6f67"),
            ColorTranslator.FromHtml("#8a620f"),
            ColorTranslator.FromHtml("#8b3434"),
            ColorTranslator.FromHtml("#6b7280"));

        public static readonly Palette SubduedDark = new(
            ColorTranslator.FromHtml("#f3f4f6"),
            ColorTranslator.FromHtml("#b8c0cc"),
            ColorTranslator.FromHtml("#475569"),
            ColorTranslator.FromHtml("#9fd8ca"),
            ColorTranslator.FromHtml("#d7bb67"),
            ColorTranslator.FromHtml("#e79a9a"),
            ColorTranslator.FromHtml("#aab2bf"));

    }
}

internal static partial class Native
{
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_APPWINDOW = 0x00040000;
    public const int WS_EX_NOACTIVATE = 0x08000000;

    [LibraryImport("user32.dll", EntryPoint = "FindWindowW", StringMarshalling = StringMarshalling.Utf16)]
    public static partial IntPtr FindWindow(string className, string? windowName);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetClientRect(IntPtr hwnd, out Rect rect);

    [LibraryImport("user32.dll")]
    public static partial IntPtr SetParent(IntPtr child, IntPtr newParent);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, [MarshalAs(UnmanagedType.Bool)] bool repaint);

    [LibraryImport("user32.dll")]
    public static partial uint GetDpiForWindow(IntPtr hwnd);
}

[StructLayout(LayoutKind.Sequential)]
internal struct Rect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}
