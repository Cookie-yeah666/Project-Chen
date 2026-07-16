using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class StartWrapper
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string targetPath = Path.Combine(appDir, "Project-Ze.exe");

            if (!File.Exists(targetPath))
            {
                MessageBox.Show(
                    "没有找到 Project-Ze.exe，请确认 start.exe 和 Project-Ze.exe 在同一个绿色版目录里。",
                    "Project-Ze 启动失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo(targetPath);
            startInfo.WorkingDirectory = appDir;
            startInfo.UseShellExecute = false;
            startInfo.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

            Process.Start(startInfo);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "启动 Project-Ze 失败：\n" + error.Message,
                "Project-Ze 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }
}
