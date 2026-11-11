using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;
using System.Drawing;
using System.Drawing.Text;
using Microsoft.Win32;

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
                || row.Blocks.Length > TaskbarQuotaCanvas.MaximumBlockCount
                || row.HiddenCount < 0)
            {
                return false;
            }
            foreach (var block in row.Blocks)
            {
                if (block is null) continue;
                if (string.IsNullOrWhiteSpace(block.TargetId)
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
    private LayoutState? _layoutState;
    private TaskbarQuotaSnapshot? _snapshot;
    private bool _displayRefreshPending;
    private float _dpiScale = 1f;
    private Color TransparentKey { get; set; } = DarkTransparentKey;
    private bool _dragging;
    private bool _movedDuringDrag;
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
        _canvas.DpiChangedAfterParent += OnDisplaySettingsChanged;
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
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
        _layoutState = LoadLayoutState();

        var bounds = LayoutBounds(
            _taskbarClientSize.Width,
            _taskbarClientSize.Height,
            _layoutState,
            PreferredWidthForTaskbar(_taskbarClientSize.Width, Scaled(DefaultPreferredWidth)));

        _layoutState ??= CaptureLayout(bounds);
        SaveLayoutState(_layoutState);
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
        Native.SetParent(Handle, taskbar);
        ApplyTaskbarMetrics(new Size(rect.Right - rect.Left, rect.Bottom - rect.Top), dpi);
        return true;
    }

    private void ApplyTaskbarMetrics(Size size, uint dpi)
    {
        var effectiveDpi = dpi > 0 ? dpi : 96u;
        _taskbarClientSize = size;
        _dpiScale = effectiveDpi / 96f;
        _canvas.SetDpi(effectiveDpi);
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e) => QueueDisplayRefresh();

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        QueueDisplayRefresh();
    }

    protected override void OnDpiChangedAfterParent(EventArgs e)
    {
        base.OnDpiChangedAfterParent(e);
        QueueDisplayRefresh();
    }

    private void QueueDisplayRefresh()
    {
        if (!IsHandleCreated || IsDisposed || _displayRefreshPending) return;
        _displayRefreshPending = true;
        try
        {
            BeginInvoke(() =>
            {
                _displayRefreshPending = false;
                if (!IsDisposed && _snapshot is { } snapshot) Render(snapshot);
            });
        }
        catch (InvalidOperationException)
        {
            _displayRefreshPending = false;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        base.Dispose(disposing);
    }

    // 아래 pixel budget은 96-DPI 기준 논리값이며, Scaled()가 taskbar monitor DPI에 맞춰 장치 pixel로 변환한다.
    private int Scaled(double value) => Math.Max(0, (int)Math.Round(value * _dpiScale));

    private Rectangle LayoutBounds(int taskbarWidth, int taskbarHeight, LayoutState? saved, int preferredWidth)
    {
        var horizontal = taskbarWidth >= taskbarHeight;
        var width = horizontal
            ? Math.Min(preferredWidth, Math.Max(Scaled(160), taskbarWidth - Scaled(8)))
            : Math.Max(Scaled(96), taskbarWidth - Scaled(VerticalWidthPadding));
        var height = horizontal
            ? Math.Min(taskbarHeight, Math.Max(Scaled(48), taskbarHeight - Scaled(HorizontalHeightPadding)))
            : Math.Min(Math.Max(Scaled(48), taskbarHeight / 5), Math.Max(Scaled(48), taskbarHeight - Scaled(8)));
        width = Math.Min(width, taskbarWidth);
        height = Math.Min(height, taskbarHeight);
        var defaultX = horizontal ? Math.Max(0, taskbarWidth - width - Scaled(DefaultRightReserve)) : Math.Max(0, (taskbarWidth - width) / 2);
        var defaultY = horizontal ? Math.Max(0, (taskbarHeight - height) / 2) : Math.Max(0, taskbarHeight - height - Scaled(160));
        var x = saved is null ? defaultX : taskbarWidth - Scaled(saved.RightInsetDip) - width;
        var y = saved is null ? defaultY : taskbarHeight - Scaled(saved.BottomInsetDip) - height;
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
        _snapshot = snapshot;
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
            _layoutState,
            PreferredWidthForTaskbar(taskbarWidth, preferredContentWidth));
        _layoutState ??= CaptureLayout(bounds);
        if (bounds.Location == Location && bounds.Size == Size) return;

        Native.MoveWindow(Handle, bounds.X, bounds.Y, bounds.Width, bounds.Height, true);
    }

    private LayoutState CaptureLayout(Rectangle bounds)
        => new((_taskbarClientSize.Width - bounds.Right) / _dpiScale, (_taskbarClientSize.Height - bounds.Bottom) / _dpiScale);

    private void WireInteractive(Control control)
    {
        control.MouseDoubleClick += OnOpenDashboard;
        control.MouseDown += BeginDrag;
        control.MouseMove += DragMove;
        control.MouseUp += EndDrag;
        control.Cursor = Cursors.SizeAll;
    }

    private void BeginDrag(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left || e.Clicks > 1) return;
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
        if (_movedDuringDrag)
        {
            _layoutState = CaptureLayout(Bounds);
            SaveLayoutState(_layoutState);
            var isLight = SampleBackgroundIsLight() ?? _canvas.BackgroundIsLight;
            ApplyTransparentKey(isLight);
            _canvas.ApplyPalette(isLight);
        }
    }

    private void OnOpenDashboard(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left || _movedDuringDrag) return;
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
internal sealed record TaskbarQuotaDisplayLine(string Period, string Label, TaskbarQuotaBlock?[] Blocks, int HiddenCount = 0);
internal sealed record LayoutState(
    [property: JsonRequired] double RightInsetDip,
    [property: JsonRequired] double BottomInsetDip);
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
    internal const int MaximumBlockCount = 5;
    private const int DividerWidth = 1;
    private const int PeriodColumn = 0;
    private const int BlockGap = 6;
    private const int HorizontalPadding = 4;
    private const int VerticalPadding = 2;
    private const int PeriodWidth = 32;
    private const int BlockHorizontalPadding = 2;
    private const int OverflowBadgeHorizontalPadding = 1;
    private const int MinimumBlockWidth = 112;
    private const int MinimumMaximumBlockWidth = 124;
    private const int MaximumMaximumBlockWidth = 260;
    private Font _periodFont = new("Segoe UI", 9.25f * 96f / 72f, FontStyle.Regular, GraphicsUnit.Pixel);
    private Font _blockFont = new("Segoe UI", 9.0f * 96f / 72f, FontStyle.Regular, GraphicsUnit.Pixel);
    private TaskbarQuotaSnapshot? _snapshot;
    private Palette _palette = Palette.SubduedDark;

    public bool BackgroundIsLight { get; private set; }

    /// <summary>소유 form이 설정하는 taskbar monitor의 장치 pixel 배율(1f = 96 DPI).</summary>
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    [System.ComponentModel.Browsable(false)]
    public float DpiScale { get; private set; } = 1f;

    public void SetDpi(uint dpi)
    {
        var scale = (dpi > 0 ? dpi : 96u) / 96f;
        if (DpiScale == scale) return;
        DpiScale = scale;
        _periodFont.Dispose();
        _blockFont.Dispose();
        _periodFont = new Font("Segoe UI", 9.25f * 96f * scale / 72f, FontStyle.Regular, GraphicsUnit.Pixel);
        _blockFont = new Font("Segoe UI", 9.0f * 96f * scale / 72f, FontStyle.Regular, GraphicsUnit.Pixel);
        Invalidate();
    }

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
            ControlStyles.StandardClick |
            ControlStyles.StandardDoubleClick |
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
        for (var index = 0; index < columns.BlockDividers.Length; index++)
        {
            if (columns[index + 2].Width > 0) DrawDivider(e.Graphics, columns.BlockDividers[index]);
        }

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
        var columns = new Rectangle[MaximumBlockCount + 1];
        columns[PeriodColumn] = period;
        var dividers = new Rectangle[MaximumBlockCount - 1];
        var x = periodDivider.Right + Scaled(BlockGap);
        for (var index = 0; index < MaximumBlockCount; index++)
        {
            var block = new Rectangle(x, content.Top, blockWidths[index], content.Height);
            columns[index + 1] = block;
            if (index < dividers.Length)
            {
                dividers[index] = new Rectangle(block.Right + (Scaled(BlockGap) / 2), content.Top, Scaled(DividerWidth), content.Height);
                x = dividers[index].Right + Scaled(BlockGap);
            }
        }

        return new ColumnLayout(columns, periodDivider, dividers);
    }

    private int[] MeasureColumnWidths(Graphics graphics, TaskbarQuotaSnapshot snapshot, int maxBlockWidth)
        => Enumerable.Range(0, MaximumBlockCount)
            .Select(index => MeasureColumnWidth(graphics, snapshot, index, maxBlockWidth)).ToArray();

    private int[] FitBlockWidths(IReadOnlyList<int> measured, int contentWidth)
    {
        var widths = measured.Take(MaximumBlockCount).ToArray();
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
            var blockWidth = 0;
            if (block is not null)
            {
                hasQuotaBlock = true;
                blockWidth = MeasureBlockWidth(graphics, block, maxBlockWidth);
            }
            if (row.HiddenCount > 0 && blockIndex == Math.Min(row.Blocks.Length, MaximumBlockCount - 1))
            {
                blockWidth = Math.Min(maxBlockWidth, blockWidth + MeasureOverflowBadgeWidth(graphics, row.HiddenCount));
            }
            width = Math.Max(width, blockWidth);
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
        var width = MeasurePrefixWidth(graphics, block, maxBlockWidth);
        foreach (var text in new[]
        {
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
        => Math.Clamp(snapshot.Lines.Take(2).Select(row => Math.Min(MaximumBlockCount, row.Blocks.Length)).DefaultIfEmpty(0).Max(), 1, MaximumBlockCount);

    private int MaximumBlockWidthFor(int availableWidth, int visibleBlockCount)
    {
        var contentWidth = Math.Max(0, availableWidth - (Scaled(HorizontalPadding) * 2));
        var blockCount = Math.Clamp(visibleBlockCount, 1, MaximumBlockCount);
        var nonBlockWidth = NonBlockWidthForBlockCount(blockCount);
        return Math.Clamp((contentWidth - nonBlockWidth) / blockCount, Scaled(MinimumMaximumBlockWidth), Scaled(MaximumMaximumBlockWidth));
    }

    private int MeasureContentWidth(IReadOnlyList<int> blockWidths)
    {
        var width = Scaled(PeriodWidth) + Scaled(DividerWidth);
        if (blockWidths.Count == 0 || blockWidths[0] <= 0) return width;

        width += Scaled(BlockGap) + blockWidths[0];
        for (var index = 1; index < Math.Min(MaximumBlockCount, blockWidths.Count); index++)
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
        var badgeIndex = Math.Min(row.Blocks.Length, MaximumBlockCount - 1);
        for (var index = 0; index < MaximumBlockCount; index++)
        {
            var cell = RowCell(columns[index + 1], rowBounds);
            var block = row.Blocks.ElementAtOrDefault(index);
            if (row.HiddenCount > 0 && index == badgeIndex && cell.Width > 0)
            {
                if (index == row.Blocks.Length)
                {
                    DrawOverflowBadge(graphics, row.HiddenCount, cell);
                    continue;
                }
                var badgeWidth = Math.Min(MeasureOverflowBadgeWidth(graphics, row.HiddenCount), cell.Width);
                var blockCell = new Rectangle(cell.Left, cell.Top, Math.Max(0, cell.Width - badgeWidth), cell.Height);
                var badgeCell = new Rectangle(cell.Right - badgeWidth, cell.Top, badgeWidth, cell.Height);
                DrawBlock(graphics, block, blockCell);
                DrawOverflowBadge(graphics, row.HiddenCount, badgeCell);
                continue;
            }
            DrawBlock(graphics, block, cell);
        }
    }

    private void DrawBlock(Graphics graphics, TaskbarQuotaBlock? block, Rectangle bounds)
    {
        if (block is null || bounds.Width <= 0) return;

        var cursor = bounds.Left + Scaled(BlockHorizontalPadding);
        var prefixText = QuotaPrefixLabel(block);
        var quotaUsedText = QuotaUsedText(block);
        var elapsedText = ElapsedText(block);
        var resetText = ResetText(block);
        var prefixWidth = MeasurePrefixWidth(graphics, block, Math.Max(0, bounds.Right - cursor));
        DrawText(
            graphics,
            prefixText,
            _blockFont,
            ProviderStatusColorFor(block.ProviderStatusTone),
            new Rectangle(cursor, bounds.Top, prefixWidth, bounds.Height));
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

    private int MeasurePrefixWidth(Graphics graphics, TaskbarQuotaBlock block, int maxWidth)
        => MeasureDrawStringWidth(graphics, QuotaPrefixLabel(block), _blockFont, maxWidth);

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
        Rectangle[] BlockDividers)
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
