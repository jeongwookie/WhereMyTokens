import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('taskbar helper imports the Unicode FindWindow entry point explicitly', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(
    source,
    /\[LibraryImport\("user32\.dll",\s*EntryPoint\s*=\s*"FindWindowW",\s*StringMarshalling\s*=\s*StringMarshalling\.Utf16\)\]\s*public static partial IntPtr FindWindow/,
  );
});

test('taskbar helper uses taskbar height instead of a fixed 44px layout cap', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.doesNotMatch(source, /DesiredHeight\s*=\s*44/);
  assert.match(source, /HorizontalHeightPadding/);
  assert.match(source, /taskbarHeight\s*-\s*(Scaled\()?HorizontalHeightPadding/);
});

test('taskbar helper can be dragged and persists its taskbar-relative position', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /MouseDown\s*\+=\s*BeginDrag/);
  assert.match(source, /MouseMove\s*\+=\s*DragMove/);
  assert.match(source, /MouseUp\s*\+=\s*EndDrag/);
  assert.match(source, /LayoutStatePath/);
  assert.match(source, /SaveLayoutState/);
  assert.match(source, /LoadLayoutState/);
});

test('taskbar helper text is sized for two readable rows', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /Segoe UI/);
  assert.doesNotMatch(source, /Segoe UI Semibold/);
  assert.match(source, /RowHeight/);
  assert.match(source, /MeasureDrawStringWidth/);
});

test('taskbar helper renders a column-aligned grid with full-height separators', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.doesNotMatch(source, /FlowLayoutPanel/);
  assert.match(source, /ComputeColumns/);
  assert.match(source, /MeasureBlockWidth/);
  assert.match(source, /BlockGap/);
  assert.match(source, /MaximumBlockWidth/);
  assert.match(source, /FitBlockWidths/);
  assert.match(source, /MeasureContentWidth\(widths\)\s*<=\s*contentWidth/);
  assert.match(source, /NonBlockWidthForBlockCount/);
  const minimumBlockWidth = Number(source.match(/MinimumBlockWidth\s*=\s*(\d+)/)?.[1]);
  const minimumMaximumBlockWidth = Number(source.match(/MinimumMaximumBlockWidth\s*=\s*(\d+)/)?.[1]);
  const blockGap = Number(source.match(/BlockGap\s*=\s*(\d+)/)?.[1]);
  const blockHorizontalPadding = Number(source.match(/BlockHorizontalPadding\s*=\s*(\d+)/)?.[1]);
  assert.ok(minimumBlockWidth > 0 && minimumBlockWidth <= 120);
  assert.ok(minimumMaximumBlockWidth > 0 && minimumMaximumBlockWidth <= 140);
  assert.ok(blockGap > 0 && blockGap <= 6);
  assert.ok(blockHorizontalPadding > 0 && blockHorizontalPadding <= 2);
  assert.match(source, /ClientSize\.Width/);
  assert.match(source, /DividerWidth/);
  assert.match(source, /DrawDivider/);
  assert.match(source, /BlockOneColumn/);
  assert.match(source, /BlockTwoColumn/);
  assert.match(source, /BlockThreeColumn/);
  assert.doesNotMatch(source, /ExtraColumn/);
  assert.doesNotMatch(source, /usableWidth\s*\/\s*2/);
});

test('taskbar helper renders compact overflow counts for hidden targets', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /HiddenCount/);
  assert.match(source, /DrawOverflowBadge/);
  assert.match(source, /\$"\+\{hiddenCount\}"/);
  assert.doesNotMatch(source, /SourceLabel/);
});

test('taskbar helper renders row status text when no quota blocks are available', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /StatusLabel/);
  assert.match(source, /row\.Blocks\.Length\s*==\s*0/);
  assert.match(source, /row\.StatusLabel\s*\?\?\s*"--"/);
  assert.match(source, /MeasureStatusWidth/);
  assert.match(source, /blockIndex\s*==\s*0[\s\S]*?StatusLabel/);
});

test('taskbar helper validates semantic snapshot arrays before rendering', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /IsValidSnapshot\(snapshot\)/);
  assert.match(source, /WriteEvent\("snapshot-rejected"\)/);
  assert.match(source, /WriteEvent\("snapshot-rendered"\)/);
  assert.match(source, /snapshot\.Rows is not \{ Length: 2 \}/);
  assert.match(source, /snapshot\.Rows\[0\]\?\.Period,\s*"5h"/);
  assert.match(source, /snapshot\.Rows\[1\]\?\.Period,\s*"1w"/);
  assert.match(source, /ValidTaskbarPeriods\.Contains\(row\.Period\)/);
  assert.match(source, /row\.Blocks is null/);
  assert.match(source, /row\.Blocks\.Length > 3/);
  assert.match(source, /row\.HiddenCount < 0/);
  assert.match(source, /string\.IsNullOrWhiteSpace\(block\.TargetId\)/);
  assert.match(source, /ValidQuotaSeverities\.Contains\(block\.Severity\)/);
  assert.match(source, /ValidProviderStatusTones\.Contains\(block\.ProviderStatusTone\)/);
});

test('taskbar helper sizes its host window from measured quota content', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /MeasurePreferredWidth/);
  assert.match(source, /ResizeToSnapshot/);
  assert.match(source, /RefreshTaskbarMetrics/);
  assert.match(source, /private void ResizeToSnapshot[\s\S]*?!RefreshTaskbarMetrics\(\)/);
  assert.match(source, /PreferredWidthForTaskbar\(taskbarWidth,\s*preferredContentWidth\)/);
  assert.doesNotMatch(source, /MinimumReadableWidth\s*=\s*780/);
});

test('taskbar helper scales layout budgets for the taskbar monitor dpi', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /GetDpiForWindow/);
  assert.match(source, /private int Scaled\(int value\)/);
  assert.match(source, /Scaled\(PeriodWidth\)/);
  assert.match(source, /Scaled\(BlockGap\)/);
  assert.match(source, /Scaled\(MinimumBlockWidth\)/);
  assert.match(source, /Scaled\(HorizontalPadding\)/);
  assert.match(source, /_canvas\.DpiScale\s*=\s*_dpiScale/);
});

test('taskbar helper avoids single-bit text rendering under dpi scaling', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /TextRenderingHint\.(AntiAliasGridFit|ClearTypeGridFit)/);
  assert.doesNotMatch(source, /SingleBitPerPixelGridFit/);
});

test('taskbar helper uses transparent background and sampled-background base text colors', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /TransparencyKey\s*=\s*TransparentKey/);
  assert.match(source, /BackColor\s*=\s*TransparentKey/);
  assert.match(source, /SampleBackgroundIsLight/);
  assert.match(source, /RelativeLuminance/);
  assert.match(source, /SampleBackgroundIsLight\(\)\s*\?\?\s*FallbackThemeIsLight\(snapshot\.Theme\)/);
  assert.match(source, /FallbackThemeIsLight/);
});

test('taskbar helper keys transparency to a color close to the real taskbar background, not a saturated color', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  // 실제 taskbar 배경과 거리가 먼 magenta key는 글자 가장자리에 색 띠를 남길 수 있다.
  // 배경에 가까운 key를 써서 안티앨리어싱 잔여 색이 자연스럽게 묻히도록 한다.
  assert.doesNotMatch(source, /Color\.FromArgb\(255,\s*0,\s*255\)/);
  assert.match(source, /DarkTransparentKey/);
  assert.match(source, /LightTransparentKey/);
  assert.match(source, /ApplyTransparentKey/);
});

test('taskbar helper project declares per-monitor-v2 dpi awareness', () => {
  const csproj = fs.readFileSync(path.resolve('taskbar-helper', 'WhereMyTokens.Taskbar.csproj'), 'utf8');
  // DPI 인식이 없으면 GetDpiForWindow가 96에 고정되어 Scaled() 기반 layout 계산이 무력화된다.
  assert.match(csproj, /<ApplicationHighDpiMode>PerMonitorV2<\/ApplicationHighDpiMode>/);
});

test('taskbar helper packaging is self-contained and single-file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.match(pkg.scripts['build:taskbar-helper'], /--self-contained true/);
  assert.match(pkg.scripts['build:taskbar-helper'], /PublishSingleFile=true/);
  assert.ok(pkg.build.files.includes('!dist/taskbar-helper/**/*'));
});

test('taskbar helper sets high dpi mode explicitly in code, not only via the msbuild property', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  // RID 지정 publish에서 MSBuild DPI 속성이 누락될 수 있으므로 API 직접 호출을 함께 유지한다.
  assert.match(source, /Application\.SetHighDpiMode\(HighDpiMode\.PerMonitorV2\)/);
  assert.match(source, /Application\.SetHighDpiMode[\s\S]*?ApplicationConfiguration\.Initialize/);
});

test('taskbar helper hides its native window from task switchers and avoids activation', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /ShowInTaskbar\s*=\s*false/);
  assert.match(source, /protected override bool ShowWithoutActivation\s*=>\s*true/);
  assert.match(source, /protected override CreateParams CreateParams/);
  assert.match(source, /WS_EX_TOOLWINDOW/);
  assert.match(source, /WS_EX_NOACTIVATE/);
  assert.match(source, /WS_EX_APPWINDOW/);
  assert.match(source, /cp\.ExStyle\s*\|=/);
  assert.match(source, /cp\.ExStyle\s*&=\s*~Native\.WS_EX_APPWINDOW/);
});

test('taskbar helper colors only quota used percent by severity', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /QuotaPrefixLabel/);
  assert.match(source, /QuotaColorFor\(block\.Severity\)/);
  assert.match(source, /ProviderStatusColorFor\(block\.ProviderStatusTone\)/);
  assert.match(source, /DrawMeasuredText\(\s*graphics,\s*prefixText,\s*_blockFont,\s*ProviderStatusColorFor\(block\.ProviderStatusTone\)/s);
  assert.match(source, /DrawMeasuredText\(\s*graphics,\s*quotaUsedText,\s*_blockFont,\s*QuotaColorFor\(block\.Severity\)/s);
  assert.match(source, /DrawMeasuredText\(\s*graphics,\s*elapsedText,\s*_blockFont,\s*_palette\.Text/s);
  assert.doesNotMatch(source, /DrawMeasuredText\(\s*graphics,\s*quotaText,\s*_blockFont,\s*QuotaColorFor\(block\.Severity\)/s);
  assert.doesNotMatch(source, /\$"\{QuotaPrefixLabel\(block\)\}\{QuotaPairText\(block\)\}"/);
  assert.match(source, /BlockDetailText/);
  assert.match(source, /_palette\.Text/);
});

test('taskbar helper sizes maximum block width from visible block columns', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /VisibleBlockCount/);
  assert.match(source, /MaximumBlockWidthFor\(taskbarWidth,\s*VisibleBlockCount\(snapshot\)\)/);
  assert.match(source, /MaximumBlockWidthFor\(ClientSize\.Width,\s*VisibleBlockCount\(snapshot\)\)/);
  assert.match(source, /NonBlockWidthForBlockCount\(blockCount\)/);
  assert.doesNotMatch(source, /MaximumBlockWidthFor\(int availableWidth,\s*int visibleBlockCount\)[\s\S]*\/\s*3/);
});

test('taskbar helper measures block width from the same text segments it draws', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /MeasureBlockContentWidth/);
  assert.match(source, /MeasureBlockWidth\(Graphics graphics,\s*TaskbarQuotaBlock\? block,\s*int maxBlockWidth\)[\s\S]*MeasureBlockContentWidth\(graphics,\s*block,\s*maxBlockWidth\)/);
  assert.match(source, /MeasureBlockContentWidth[\s\S]*QuotaPrefixLabel\(block\)[\s\S]*QuotaUsedText\(block\)[\s\S]*ElapsedText\(block\)[\s\S]*ResetText\(block\)/);
  assert.doesNotMatch(source, /MeasureDrawStringWidth\(graphics,\s*\$"\{QuotaPrefixLabel\(block\)\}\{BlockDetailText\(block\)\}",\s*_blockFont,\s*maxBlockWidth\)/);
});

test('taskbar helper uses a subdued taskbar palette without text shadows', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /SubduedDark/);
  assert.match(source, /SubduedLight/);
  assert.doesNotMatch(source, /Color\.Black\)/);
  assert.doesNotMatch(source, /Color\.White\)/);
  assert.doesNotMatch(source, /shadowBounds/);
  assert.doesNotMatch(source, /_palette\.Shadow/);
});

test('taskbar helper renders uppercase periods, percent pairs, and largest-unit reset text', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /PeriodWidth\s*=\s*(3[0-9]|[4-9][0-9])/);
  assert.match(source, /PeriodText/);
  assert.match(source, /ToUpperInvariant/);
  assert.match(source, /QuotaPairText/);
  assert.match(source, /return \$"\{quota\}\/\{elapsed\}"/);
  assert.match(source, /PctText/);
  assert.match(source, /%"/);
  assert.match(source, /ResetText/);
  assert.doesNotMatch(source, /SourceLabel/);
  assert.doesNotMatch(source, /SourceText/);
  assert.match(source, /BlockDetailText\(TaskbarQuotaBlock block\)\s*=>\s*\$"\{QuotaPairText\(block\)\}\{ResetText\(block\)\}"/);
});

test('taskbar helper measures owner-drawn text with the same API it uses to draw it', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /MeasureDrawStringWidth/);
  assert.match(source, /MeasureString/);
  assert.doesNotMatch(source, /private int DrawMeasuredText[\s\S]*?TextRenderer\.MeasureText/);
});

test('taskbar helper uses one owner-drawn surface instead of per-cell labels for text', () => {
  const source = fs.readFileSync(path.resolve('taskbar-helper', 'Program.cs'), 'utf8');
  assert.match(source, /internal sealed class TaskbarQuotaCanvas : Control/);
  assert.match(source, /protected override void OnPaint/);
  assert.match(source, /DrawString/);
  assert.doesNotMatch(source, /private static Label PeriodLabel/);
  assert.doesNotMatch(source, /new Label\s*\{/);
});
