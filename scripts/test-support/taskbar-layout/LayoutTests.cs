using System.Drawing;
using System.Reflection;
using System.Text.Json;
using System.Windows.Forms;

namespace WhereMyTokens.Taskbar;

internal static class LayoutTests
{
    private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
    private static int _checks;

    private static void Check(bool condition, string name)
    {
        if (!condition) throw new Exception(name);
        _checks++;
    }

    [STAThread]
    private static void Main()
    {
        // 창을 표시하거나 작업표시줄에 연결하지 않고 실제 계산과 이벤트만 검사한다.
        using var form = new TaskbarQuotaForm();
        var type = typeof(TaskbarQuotaForm);
        var layout = type.GetMethod("LayoutBounds", PrivateInstance)!;
        Rectangle Bounds(int width, int height, LayoutState? saved, int contentWidth) =>
            (Rectangle)layout.Invoke(form, [width, height, saved, contentWidth])!;
        var metrics = type.GetMethod("ApplyTaskbarMetrics", PrivateInstance)!;
        void Display(int width, int height, uint dpi) => metrics.Invoke(form, [new Size(width, height), dpi]);
        var saved = JsonSerializer.Deserialize<LayoutState>(JsonSerializer.Serialize(new LayoutState(100, 2)), JsonOptions.Value)!;
        Display(1920, 60, 96);
        Check(Bounds(1920, 60, saved, 300).Right == 1820, "initial right inset");
        Check(Bounds(1920, 60, saved, 700).Right == 1820, "expanded content preserves right inset");
        Check(Bounds(1920, 60, saved, 200).Right == 1820, "shrunk content preserves right inset");
        Display(3840, 60, 96);
        Check(Bounds(3840, 60, saved, 300).Right == 3740, "resolution change moves the anchor");
        Display(2880, 90, 144);
        var scaled = Bounds(2880, 90, saved, 600);
        Check(scaled.Right == 2730 && scaled.Bottom == 87, "DPI change scales both insets");
        Display(240, 48, 96);
        var clipped = Bounds(240, 48, saved, 300);
        Check(clipped.X >= 0 && clipped.Right <= 240, "small display clipping");
        Display(1920, 60, 96);
        Check(Bounds(1920, 60, saved, 300).Right == 1820, "return from clipped display restores the intended inset");
        Display(80, 1080, 144);
        var vertical = Bounds(80, 1080, saved, 600);
        Check(vertical.X >= 0 && vertical.Right <= 80 && vertical.Bottom == 1077, "vertical taskbar insets");
        var rejected = false;
        try { JsonSerializer.Deserialize<LayoutState>("{\"X\":500,\"Y\":2,\"Right\":1200}", JsonOptions.Value); }
        catch (JsonException) { rejected = true; }
        Check(rejected, "absolute-pixel position is not interpreted as edge insets");

        var canvas = (Control)type.GetField("_canvas", PrivateInstance)!.GetValue(form)!;
        var output = new StringWriter();
        var original = Console.Out;
        try
        {
            Console.SetOut(output);
            typeof(Control).GetMethod("OnClick", PrivateInstance)!.Invoke(canvas, [EventArgs.Empty]);
            Check(output.ToString() == "", "single click does not open");
            var doubleClick = typeof(Control).GetMethod("OnMouseDoubleClick", PrivateInstance)!;
            doubleClick.Invoke(canvas, [new MouseEventArgs(MouseButtons.Right, 2, 0, 0, 0)]);
            Check(output.ToString() == "", "right double click does not open");
            doubleClick.Invoke(canvas, [new MouseEventArgs(MouseButtons.Left, 2, 0, 0, 0)]);
            Check(output.ToString().Contains("open-dashboard"), "left double click opens");
            output.GetStringBuilder().Clear();
            type.GetField("_movedDuringDrag", PrivateInstance)!.SetValue(form, true);
            doubleClick.Invoke(canvas, [new MouseEventArgs(MouseButtons.Left, 2, 0, 0, 0)]);
            Check(output.ToString() == "", "drag does not open");
        }
        finally { Console.SetOut(original); }
        CheckQuotaColumns();
        CheckFiveColumns();
        CheckDpiTransitions();
        Console.WriteLine($"Taskbar layout checks passed: {_checks}");
    }

    private static void CheckQuotaColumns()
    {
        var gemini = new TaskbarQuotaBlock("gemini", "antigravity", "GM", "Gemini Models", "limited", 0, 13, false, "4h", "normal", "normal");
        var agent = gemini with { TargetId = "agent", Abbreviation = "G4A", Label = "Gemini 4 Agent" };
        var codex = gemini with { TargetId = "codex", Provider = "codex", Abbreviation = "X", UsedPct = 45, ElapsedPct = 62, ResetLabel = "3d" };
        var snapshot = new TaskbarQuotaSnapshot(1, "dark", [
            new("5h", "5h", [null, gemini, null]),
            new("7d", "1w", [codex, gemini, agent]),
        ]);
        var roundTrip = JsonSerializer.Deserialize<TaskbarQuotaSnapshot>(JsonSerializer.Serialize(snapshot), JsonOptions.Value)!;
        var validate = typeof(Program).GetMethod("IsValidSnapshot", BindingFlags.Static | BindingFlags.NonPublic)!;
        bool IsValid(TaskbarQuotaSnapshot value) => (bool)validate.Invoke(null, [value])!;
        Check(IsValid(roundTrip), "empty source cells survive protocol validation");
        Check(roundTrip.Lines[0].Blocks[0] is null && roundTrip.Lines[0].Blocks[1]?.TargetId == "gemini", "source column survives serialization");
        Check(!IsValid(snapshot with { Lines = [snapshot.Lines[0], new("7d", "1w", [agent with { TargetId = "" }])] }), "invalid quota block remains rejected");

        using var canvas = new TaskbarQuotaCanvas();
        var type = typeof(TaskbarQuotaCanvas);
        var prefix = type.GetMethod("MeasurePrefixWidth", PrivateInstance)!;
        var blockContent = type.GetMethod("MeasureBlockContentWidth", PrivateInstance)!;
        var column = type.GetMethod("MeasureColumnWidth", PrivateInstance)!;
        var compute = type.GetMethod("ComputeColumns", PrivateInstance)!;
        var paint = type.GetMethod("OnPaint", PrivateInstance)!;
        foreach (var scale in new[] { 1f, 1.5f, 2f })
        {
            canvas.SetDpi((uint)(96 * scale));
            var font = (Font)type.GetField("_blockFont", PrivateInstance)!.GetValue(canvas)!;
            canvas.Size = new Size((int)(600 * scale), (int)(56 * scale));
            using var bitmap = new Bitmap(canvas.Width, canvas.Height);
            bitmap.SetResolution(96 * scale, 96 * scale);
            using var graphics = Graphics.FromImage(bitmap);
            int PrefixWidth(TaskbarQuotaBlock block) => (int)prefix.Invoke(canvas, [graphics, block, canvas.Width])!;
            using var format = new StringFormat { FormatFlags = StringFormatFlags.NoWrap };
            foreach (var abbreviation in new[] { "X", "GM", "G4A", "WW", "WWW" })
            {
                var width = PrefixWidth(gemini with { Abbreviation = abbreviation });
                Check(width >= Math.Ceiling(graphics.MeasureString($"{abbreviation}:", font, canvas.Width, format).Width), $"full {abbreviation} prefix at {scale} DPI scale");
            }
            var shortPrefix = gemini with { Abbreviation = "X" };
            Check(PrefixWidth(shortPrefix) < PrefixWidth(gemini) && PrefixWidth(gemini) < PrefixWidth(agent), $"prefix budget follows actual abbreviation width at {scale} DPI scale");
            int ContentWidth(TaskbarQuotaBlock block) => (int)blockContent.Invoke(canvas, [graphics, block, canvas.Width])!;
            var longPrefix = gemini with { Abbreviation = "G4A" };
            Check(ContentWidth(shortPrefix) < ContentWidth(gemini) && ContentWidth(gemini) < ContentWidth(longPrefix), $"content budget follows the same abbreviation width at {scale} DPI scale");
            var content = Rectangle.Inflate(canvas.ClientRectangle, -(int)(4 * scale), -(int)(2 * scale));
            var layout = compute.Invoke(canvas, [graphics, content, snapshot])!;
            var columns = (Rectangle[])layout.GetType().GetProperty("Columns")!.GetValue(layout)!;
            Check(columns.Skip(1).Take(3).All(cell => cell.Width > 0) && columns[3].Right <= content.Right, $"three aligned columns fit at {scale} DPI scale");
            canvas.Render(snapshot, false);
            paint.Invoke(canvas, [new PaintEventArgs(graphics, canvas.ClientRectangle)]);
            var rowHeight = (int)type.GetProperty("RowHeight", PrivateInstance)!.GetValue(canvas)!;
            Rectangle Cell(int columnIndex, int row) => new(columns[columnIndex].Left, content.Top + row * rowHeight, columns[columnIndex].Width, rowHeight);
            bool HasText(Rectangle bounds)
            {
                for (var y = bounds.Top; y < Math.Min(bitmap.Height, bounds.Bottom); y++)
                    for (var x = bounds.Left; x < Math.Min(bitmap.Width, bounds.Right); x++)
                        if (bitmap.GetPixel(x, y).ToArgb() != canvas.TransparentKey.ToArgb()) return true;
                return false;
            }
            Check(!HasText(Cell(1, 0)) && HasText(Cell(1, 1)), $"weekly-only source leaves an empty short-period cell at {scale} DPI scale");
            Check(HasText(Cell(2, 0)) && HasText(Cell(2, 1)), $"shared source draws in the same column at {scale} DPI scale");
            var overflow = snapshot with { Lines = [new("5h", "5h", [null, gemini, null], 12), snapshot.Lines[1]] };
            var overflowWidth = (int)column.Invoke(canvas, [graphics, overflow, 3, canvas.Width])!;
            Check(overflowWidth > 0, $"overflow in an empty final cell is measured at {scale} DPI scale");
            canvas.Render(overflow, false);
            paint.Invoke(canvas, [new PaintEventArgs(graphics, canvas.ClientRectangle)]);
            var overflowLayout = compute.Invoke(canvas, [graphics, content, overflow])!;
            columns = (Rectangle[])overflowLayout.GetType().GetProperty("Columns")!.GetValue(overflowLayout)!;
            Check(HasText(Cell(4, 0)), $"overflow draws in an empty final cell at {scale} DPI scale");
        }
    }

    private static void CheckFiveColumns()
    {
        var blocks = new[] { "C", "X", "GM", "CG", "G4A" }.Select((prefix, i) =>
            new TaskbarQuotaBlock($"target-{i}", "antigravity", prefix, prefix, "limited", 25, 50, false, "2h", "normal", "normal")).ToArray();
        var snapshot = new TaskbarQuotaSnapshot(1, "dark", [
            new("5h", "5h", [blocks[0], blocks[1], blocks[2], blocks[3], null]),
            new("7d", "1w", blocks),
        ]);
        var validate = typeof(Program).GetMethod("IsValidSnapshot", BindingFlags.Static | BindingFlags.NonPublic)!;
        Check((bool)validate.Invoke(null, [snapshot])!, "five blocks pass protocol validation");
        var oversized = snapshot with { Lines = [new("5h", "5h", [.. blocks, blocks[0]]), snapshot.Lines[1]] };
        Check(!(bool)validate.Invoke(null, [oversized])!, "six blocks are rejected");
        using var canvas = new TaskbarQuotaCanvas();
        var type = typeof(TaskbarQuotaCanvas);
        var compute = type.GetMethod("ComputeColumns", PrivateInstance)!;
        var paint = type.GetMethod("OnPaint", PrivateInstance)!;
        foreach (var scale in new[] { 1f, 1.5f, 2f })
        foreach (var width in new[] { 1100, 600, 280 })
        {
            canvas.SetDpi((uint)(96 * scale));
            canvas.Size = new Size((int)(width * scale), (int)(56 * scale));
            using var bitmap = new Bitmap(canvas.Width, canvas.Height);
            bitmap.SetResolution(96 * scale, 96 * scale);
            using var graphics = Graphics.FromImage(bitmap);
            var content = Rectangle.Inflate(canvas.ClientRectangle, -(int)(4 * scale), -(int)(2 * scale));
            var layout = compute.Invoke(canvas, [graphics, content, snapshot])!;
            var columns = (Rectangle[])layout.GetType().GetProperty("Columns")!.GetValue(layout)!;
            Check(columns.Skip(1).All(cell => cell.Width > 0) && columns[5].Right <= content.Right, $"five columns fit width {width} at {scale} DPI scale");
            Check(Enumerable.Range(1, 4).All(i => columns[i].Right < columns[i + 1].Left), $"five columns never overlap at width {width} and {scale} DPI scale");
            canvas.Render(snapshot, false);
            paint.Invoke(canvas, [new PaintEventArgs(graphics, canvas.ClientRectangle)]);
            var rowHeight = (int)type.GetProperty("RowHeight", PrivateInstance)!.GetValue(canvas)!;
            Rectangle Cell(int column, int row) => new(columns[column].Left, content.Top + row * rowHeight, columns[column].Width, rowHeight);
            bool HasText(Rectangle bounds)
            {
                for (var y = bounds.Top; y < Math.Min(bitmap.Height, bounds.Bottom); y++)
                    for (var x = bounds.Left; x < Math.Min(bitmap.Width, bounds.Right); x++)
                        if (bitmap.GetPixel(x, y).ToArgb() != canvas.TransparentKey.ToArgb()) return true;
                return false;
            }
            Check(HasText(Cell(4, 0)) && HasText(Cell(4, 1)), $"fourth column draws both periods at width {width} and {scale} DPI scale");
            Check(!HasText(Cell(5, 0)) && HasText(Cell(5, 1)), $"fifth column keeps its missing-period cell empty at width {width} and {scale} DPI scale");
            var overflow = snapshot with { Lines = [snapshot.Lines[0], snapshot.Lines[1] with { HiddenCount = 12 }] };
            canvas.Render(overflow, false);
            paint.Invoke(canvas, [new PaintEventArgs(graphics, canvas.ClientRectangle)]);
            Check(HasText(Cell(5, 1)), $"five-column overflow draws at width {width} and {scale} DPI scale");
        }
    }
    private static void CheckDpiTransitions()
    {
        using var canvas = new TaskbarQuotaCanvas();
        using var bitmap = new Bitmap(800, 120);
        bitmap.SetResolution(96, 96);
        using var graphics = Graphics.FromImage(bitmap);
        var fontField = typeof(TaskbarQuotaCanvas).GetField("_blockFont", PrivateInstance)!;
        float? baseWidth = null;
        foreach (var dpi in new uint[] { 96, 144, 192, 144, 96, 144, 96 })
        {
            canvas.SetDpi(dpi);
            var font = (Font)fontField.GetValue(canvas)!;
            Check(font.Unit == GraphicsUnit.Pixel && Math.Abs(font.Size - (9f * dpi / 72f)) < 0.01f, $"pixel font follows window DPI {dpi}");
            var width = graphics.MeasureString("GM: 100% /100% 21h", font).Width;
            baseWidth ??= width;
            Check(Math.Abs(width / baseWidth.Value - dpi / 96f) < 0.08f, $"text follows window DPI {dpi} with unchanged 96-DPI graphics");
            var oldFont = font;
            canvas.SetDpi(dpi);
            Check(ReferenceEquals(fontField.GetValue(canvas), oldFont), $"unchanged DPI {dpi} reuses the font");
        }
    }

}
