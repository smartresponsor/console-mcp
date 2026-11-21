using System.Diagnostics;
var argsList = Environment.GetCommandLineArgs().Skip(1).ToArray();
var mode = Path.GetFileNameWithoutExtension(Environment.ProcessPath ?? "").Replace("git-fixture-", "");
var upstream = argsList.Length >= 2 && argsList[0] == "rev-parse" && argsList[1] == "--abbrev-ref";
if (mode == "status" && argsList.FirstOrDefault() == "status") { Console.Error.WriteLine("status inspection denied"); return 37; }
if (mode == "missing-upstream" && upstream) { Console.Error.WriteLine("fatal: upstream branch 'refs/heads/fix/test' not stored as a remote-tracking branch"); return 128; }
if (mode == "upstream" && upstream) { Console.Error.WriteLine("upstream inspection failed"); return 38; }
if (mode == "ownership") { Console.Error.WriteLine("fatal: detected dubious ownership in repository"); return 128; }
var git = Environment.GetEnvironmentVariable("GIT_EXECUTABLE");
if (string.IsNullOrWhiteSpace(git) || !Path.IsPathFullyQualified(git)) { Console.Error.WriteLine("Missing absolute GIT_EXECUTABLE"); return 125; }
var start = new ProcessStartInfo(git) { UseShellExecute = false };
foreach (var arg in argsList) start.ArgumentList.Add(arg);
using var child = Process.Start(start) ?? throw new InvalidOperationException("Git process did not start");
await child.WaitForExitAsync();
return child.ExitCode;
