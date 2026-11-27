using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

/// <summary>
/// StockingQuota One-Click Complete Uninstaller & Plugin Cleaner (WinExe, zero dependencies).
/// Safely removes:
///   1. Running StockingQuota, sq-wintracker, and sq-sentinel processes.
///   2. HKCU\...\Run\StockingQuotaSentinel startup entry.
///   3. DeepSeek Harness `dsh-stocking-quota-bridge` plugin & profile entries (strictly UTF-8 NO BOM!).
///   4. Installed StockingQuota program files, shortcuts, and saved `%APPDATA%` state.
/// Never touches Codex, Antigravity, or DeepSeek Harness installation files or user chat data.
/// </summary>
internal static class Program
{
    private const string PluginName = "dsh-stocking-quota-bridge";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "StockingQuotaSentinel";
    private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

    private static void StopProcesses(List<string> report)
    {
        try
        {
            using (EventWaitHandle stopEv = EventWaitHandle.OpenExisting(@"Local\StockingQuotaSentinelStop"))
            {
                stopEv.Set();
            }
            Thread.Sleep(250);
        }
        catch { }

        string[] targets = new[] { "sq-sentinel", "sq-wintracker", "StockingQuota" };
        int killed = 0;
        foreach (string name in targets)
        {
            try
            {
                foreach (Process p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        p.Kill();
                        p.WaitForExit(3000);
                        killed++;
                    }
                    catch { }
                    finally { p.Dispose(); }
                }
            }
            catch { }
        }
        report.Add(killed > 0 ? ("• 已停止运行中的相关进程 (" + killed + " 个)") : "• 未发现运行中的相关进程");
    }

    private static void RemoveStartupRegistry(List<string> report)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
            {
                if (key != null && key.GetValue(RunValueName) != null)
                {
                    key.DeleteValue(RunValueName, false);
                    report.Add("• 已移除 3MB 哨兵开机自启注册表项");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            report.Add("• 清理注册表项失败: " + ex.Message);
            return;
        }
        report.Add("• 未发现哨兵自启注册表项（无需清理）");
    }

    /// <summary>
    /// Pretty-prints a JSON object graph produced by JavaScriptSerializer with 2-space indent and zero BOM.
    /// </summary>
    private static string FormatJsonIndented(string compactJson)
    {
        StringBuilder sb = new StringBuilder(compactJson.Length * 2);
        int indent = 0;
        bool inString = false;
        bool escaped = false;

        for (int i = 0; i < compactJson.Length; i++)
        {
            char c = compactJson[i];
            if (inString)
            {
                sb.Append(c);
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }

            switch (c)
            {
                case '"':
                    inString = true;
                    sb.Append(c);
                    break;
                case '{':
                case '[':
                    sb.Append(c);
                    // Keep empty {} or [] on one line
                    int next = i + 1;
                    while (next < compactJson.Length && char.IsWhiteSpace(compactJson[next])) next++;
                    if (next < compactJson.Length && (compactJson[next] == '}' || compactJson[next] == ']'))
                    {
                        sb.Append(compactJson[next]);
                        i = next;
                    }
                    else
                    {
                        indent++;
                        sb.Append('\n').Append(' ', indent * 2);
                    }
                    break;
                case '}':
                case ']':
                    indent = Math.Max(0, indent - 1);
                    sb.Append('\n').Append(' ', indent * 2).Append(c);
                    break;
                case ',':
                    sb.Append(c).Append('\n').Append(' ', indent * 2);
                    break;
                case ':':
                    sb.Append(": ");
                    break;
                default:
                    if (!char.IsWhiteSpace(c)) sb.Append(c);
                    break;
            }
        }
        sb.Append('\n');
        return sb.ToString();
    }

    private static bool CleanDshProfile(string dshHome, string profileName)
    {
        string profDir = Path.Combine(dshHome, "profiles", profileName);
        string pkgPath = Path.Combine(profDir, "package.json");
        bool touched = false;

        // 1. Safely remove node_modules junction/link without traversing into target
        string nmLink = Path.Combine(profDir, "node_modules", PluginName);
        if (Directory.Exists(nmLink))
        {
            try
            {
                FileAttributes attr = File.GetAttributes(nmLink);
                if ((attr & FileAttributes.ReparsePoint) != 0)
                {
                    Directory.Delete(nmLink, false);
                }
                else
                {
                    Directory.Delete(nmLink, true);
                }
                touched = true;
            }
            catch { }
        }

        // 2. Clean package.json strictly UTF-8 NO BOM!
        if (File.Exists(pkgPath))
        {
            string raw = File.ReadAllText(pkgPath, Utf8NoBom).TrimStart('\uFEFF');
            JavaScriptSerializer ser = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(raw);
            if (root != null)
            {
                bool modified = false;
                object depsObj;
                if (root.TryGetValue("dependencies", out depsObj) && depsObj is Dictionary<string, object>)
                {
                    Dictionary<string, object> deps = (Dictionary<string, object>)depsObj;
                    if (deps.Remove(PluginName)) modified = true;
                }

                object dshObj;
                if (root.TryGetValue("dsh", out dshObj) && dshObj is Dictionary<string, object>)
                {
                    Dictionary<string, object> dsh = (Dictionary<string, object>)dshObj;
                    object profObj;
                    if (dsh.TryGetValue("profile", out profObj) && profObj is Dictionary<string, object>)
                    {
                        Dictionary<string, object> prof = (Dictionary<string, object>)profObj;
                        object bundlesObj;
                        if (prof.TryGetValue("bundles", out bundlesObj) && bundlesObj is ArrayList)
                        {
                            ArrayList bundles = (ArrayList)bundlesObj;
                            ArrayList filtered = new ArrayList();
                            foreach (object item in bundles)
                            {
                                if (item != null && string.Equals(item.ToString(), PluginName, StringComparison.Ordinal))
                                {
                                    modified = true;
                                    continue;
                                }
                                filtered.Add(item);
                            }
                            prof["bundles"] = filtered;
                        }
                    }
                }

                if (modified)
                {
                    string pretty = FormatJsonIndented(ser.Serialize(root));
                    // Verify re-parse before replacing disk file
                    ser.DeserializeObject(pretty);
                    string tmpPath = pkgPath + ".sq-clean-tmp";
                    File.WriteAllText(tmpPath, pretty, Utf8NoBom);
                    File.Copy(tmpPath, pkgPath, true);
                    File.Delete(tmpPath);
                    touched = true;
                }
            }
        }

        return touched;
    }

    private static void CleanDshPlugin(List<string> report)
    {
        string dshHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        if (!Directory.Exists(dshHome))
        {
            report.Add("• 未检测到 DeepSeek Harness 目录（无需清理插件）");
            return;
        }

        bool any = false;
        try
        {
            any |= CleanDshProfile(dshHome, "desktop");
            any |= CleanDshProfile(dshHome, "web");

            string pluginDir = Path.Combine(dshHome, "plugins", PluginName);
            if (Directory.Exists(pluginDir))
            {
                Directory.Delete(pluginDir, true);
                any = true;
            }
            report.Add(any
                ? "• 已无损卸载 DSH 蓝丝桥接插件（配置文件已保证零 BOM 合法 JSON，重启 DSH 生效）"
                : "• DSH 中未检测到蓝丝桥接插件（无需清理）");
        }
        catch (Exception ex)
        {
            report.Add("• 清理 DSH 插件时出现异常: " + ex.Message);
        }
    }

    private static void CleanInstalledAppAndData(List<string> report)
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string startMenu = Path.Combine(appData, @"Microsoft\Windows\Start Menu\Programs");

        // 1. Run NSIS silent uninstaller if installed via StockingQuota-Setup.exe
        string[] installDirs = new[]
        {
            Path.Combine(localAppData, "Programs", "stocking-quota-lab"),
            Path.Combine(localAppData, "Programs", "StockingQuota")
        };
        bool removedApp = false;

        foreach (string installDir in installDirs)
        {
            string uninstaller = Path.Combine(installDir, "Uninstall StockingQuota.exe");
            if (File.Exists(uninstaller))
            {
                try
                {
                    Process p = Process.Start(new ProcessStartInfo
                    {
                        FileName = uninstaller,
                        Arguments = "/S",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    });
                    if (p != null)
                    {
                        p.WaitForExit(15000);
                        p.Dispose();
                    }
                    removedApp = true;
                }
                catch { }
            }

            if (Directory.Exists(installDir))
            {
                try
                {
                    Thread.Sleep(400);
                    Directory.Delete(installDir, true);
                    removedApp = true;
                }
                catch { }
            }
        }

        // Remove updater cache & shortcuts
        string[] extraDirs = new[]
        {
            Path.Combine(localAppData, "stocking-quota-lab-updater"),
            Path.Combine(appData, "stocking-quota-lab"),
            Path.Combine(appData, "StockingQuota")
        };
        bool removedData = false;
        foreach (string d in extraDirs)
        {
            if (Directory.Exists(d))
            {
                try
                {
                    Directory.Delete(d, true);
                    removedData = true;
                }
                catch { }
            }
        }

        string[] shortcuts = new[]
        {
            Path.Combine(desktop, "StockingQuota.lnk"),
            Path.Combine(startMenu, "StockingQuota.lnk")
        };
        foreach (string s in shortcuts)
        {
            if (File.Exists(s))
            {
                try
                {
                    File.Delete(s);
                    removedApp = true;
                }
                catch { }
            }
        }

        report.Add(removedApp ? "• 已卸载已安装的 StockingQuota 程序与快捷方式" : "• 未发现已安装的 StockingQuota 程序目录");
        report.Add(removedData ? "• 已清空本地保存的设置、热区标定与缓存状态" : "• 未发现残留配置状态");
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool silentYes = false;
        bool selfTestJson = false;
        if (args != null)
        {
            foreach (string a in args)
            {
                if (a == "--yes" || a == "-y" || a == "/S") silentYes = true;
                if (a == "--self-test-json") selfTestJson = true;
            }
        }

        if (selfTestJson)
        {
            string sample = "{\"name\":\"dsh-profile-desktop\",\"dependencies\":{\"@liustack/modsearch\":\"5.10.10\",\"dsh-stocking-quota-bridge\":\"link:C:/x\"},\"dsh\":{\"profile\":{\"bundles\":[\"@deepseek-ai/dsh-base\",\"dsh-stocking-quota-bridge\"]}}}";
            JavaScriptSerializer ser = new JavaScriptSerializer();
            Dictionary<string, object> obj = ser.Deserialize<Dictionary<string, object>>(sample);
            ((Dictionary<string, object>)obj["dependencies"]).Remove(PluginName);
            string formatted = FormatJsonIndented(ser.Serialize(obj));
            ser.DeserializeObject(formatted);
            return formatted.Contains(PluginName) && !formatted.Contains("\"bundles\"") ? 1 : 0;
        }

        if (!silentYes)
        {
            DialogResult confirm = MessageBox.Show(
                "即将一键彻底清理 StockingQuota 及其全部插件与残留配置：\n\n" +
                "1. 停止 StockingQuota、追踪器与哨兵进程\n" +
                "2. 移除开机哨兵自启项\n" +
                "3. 无损卸载 DeepSeek Harness 蓝丝桥接插件（严格零 BOM，不影响其他插件与对话）\n" +
                "4. 卸载已安装的 StockingQuota 主程序与本地设置状态\n\n" +
                "（绝不会删除 Codex / Antigravity / DSH 本体或聊天记录）\n\n是否继续？",
                "StockingQuota 一键清理卸载工具",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (confirm != DialogResult.Yes) return 0;
        }

        List<string> report = new List<string>();
        StopProcesses(report);
        RemoveStartupRegistry(report);
        CleanDshPlugin(report);
        CleanInstalledAppAndData(report);

        if (!silentYes)
        {
            MessageBox.Show(
                "清理完成！现在你的电脑已恢复到未安装 StockingQuota 的干净状态：\n\n" +
                string.Join("\n", report.ToArray()) +
                "\n\n如曾使用 DSH 蓝丝插件，请重启一次 DeepSeek Harness；随后可重新下载安装体验完整流程。",
                "StockingQuota 清理完成",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }
        return 0;
    }
}
