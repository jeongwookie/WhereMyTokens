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
        var anchor = type.GetField("_rightAnchor", PrivateInstance)!;
        anchor.SetValue(form, 1200);
        Check(Bounds(1920, 60, null, 300).Right == 1200, "initial anchor");
        Check(Bounds(1920, 60, null, 700).Right == 1200, "expanded anchor");
        Check(Bounds(1920, 60, null, 200).Right == 1200, "shrunk anchor");
        var clipped = Bounds(800, 60, null, 300);
        Check(clipped.X >= 0 && clipped.Right <= 800, "screen clipping");
        anchor.SetValue(form, null);
        var saved = JsonSerializer.Deserialize<LayoutState>(JsonSerializer.Serialize(new LayoutState(500, 2, 1200)))!;
        Check(Bounds(1920, 60, saved, 300).Right == 1200, "restart at different width");
        var legacy = JsonSerializer.Deserialize<LayoutState>("{\"X\":500,\"Y\":2}")!;
        Check(legacy.Right is null && Bounds(1920, 60, legacy, 300).X == 500, "legacy position");
        type.GetField("_dpiScale", PrivateInstance)!.SetValue(form, 1.5f);
        Check(Bounds(2880, 90, saved, 600).Right == 1200, "scaled DPI anchor");
        var vertical = Bounds(80, 1080, saved, 600);
        Check(vertical.X >= 0 && vertical.Right <= 80, "vertical bounds");

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
        Console.WriteLine($"Taskbar layout checks passed: {_checks}");
    }
}
