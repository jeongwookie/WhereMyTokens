/** Traditional Chinese text for Electron's native dialogs, tray menus and notices. */
export const nativeZhTWText: Readonly<Record<string, string>> = {
  'Copy command': '複製指令',
  'Open install guide': '開啟安裝指南',
  'Cancel': '取消',
  'Claude Code login required': '需要登入 Claude Code',
  'Claude Code was not found on this computer.': '這台電腦找不到 Claude Code。',
  'WhereMyTokens could not open the Claude Code login terminal.': 'WhereMyTokens 無法開啟 Claude Code 登入終端機。',
  'Run this official command in a terminal: claude auth login': '請在終端機執行官方指令：claude auth login',
  'Click to open the official Claude Code login. WhereMyTokens will not refresh or modify credentials.': '點選以開啟 Claude Code 官方登入流程。WhereMyTokens 不會更新或修改登入憑證。',
  'Taskbar mini disabled': '工作列迷你額度顯示已停用',
  'The taskbar mini quota helper could not start after repeated attempts. Open Settings to enable it again after checking Windows taskbar support.': '工作列迷你額度程式多次啟動失敗。請確認 Windows 工作列相容性，再至設定中重新啟用。',
  'Hide Widget': '隱藏小工具',
  'Show Widget': '顯示小工具',
  'Open WhereMyTokens': '開啟 WhereMyTokens',
  'Settings': '設定',
  'Quit': '結束',
  'Open dashboard': '開啟儀表板',
  'Refresh now': '立即重新整理',
  'Hide widget': '隱藏小工具',
  'Show widget': '顯示小工具',
  'Hide dashboard': '隱藏儀表板',
  'Today': '今天',
};

export function nativeZhTW(english: string): string {
  return nativeZhTWText[english] ?? english;
}
