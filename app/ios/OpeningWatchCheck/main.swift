import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    if !ok { failures += 1; print("FAIL \(what)") }
}

var silent = OpeningWatch(now: 0, answerLimit: 20)
silent.progress(0.1)
check(silent.stage(at: 19.9) == .opening, "waits for an answer until the limit")
check(silent.stage(at: 20) == .noAnswer, "gives up at the limit with no answer")

var slow = OpeningWatch(now: 0, answerLimit: 20)
slow.answer(at: 1.5)
check(slow.stage(at: 4.9) == .opening, "says nothing before slowAfterSeconds")
check(slow.stage(at: 5) == .slow, "calls the link slow after slowAfterSeconds")
var at = 5.0
while at <= 300 {
    slow.progress(0.4)
    check(slow.stage(at: at + 1) == .slow, "still slow, never given up, at \(at)")
    at += 5
}

var bar = OpeningWatch(now: 0, answerLimit: 20)
bar.answer(at: 1)
bar.progress(0.4)
check(bar.shownProgress() == 0.4, "shows the page's progress")
bar.progress(0.3)
check(bar.shownProgress() == 0.4, "never goes back")
bar.progress(1.0)
check(bar.shownProgress() == OpeningWatch.maxShown, "stops short of full")

var early = OpeningWatch(now: 0, answerLimit: 20)
early.progress(0.1)
early.progress(0.2)
check(early.stage(at: 20) == .noAnswer, "WebKit's own progress before an answer is no answer")
check(early.shownProgress() == 0, "the bar stays empty before an answer")

// estimatedProgress held still while a large file arrives: still slow, never given up
var held = OpeningWatch(now: 0, answerLimit: 20)
held.answer(at: 1)
held.progress(0.41)
check(held.stage(at: 120) == .slow, "a progress that holds still is not a stall")

for host in ["192.168.0.10", "10.0.2.2", "172.16.0.1", "169.254.1.2", "127.0.0.1", "100.64.0.1", "localhost", "app.localhost",
             "[::1]", "[fd00::1]", "[fe80::1]", "[fd7a:115c:a1e0::1]", "studio", "pc.local", "pc.lan", "pc.home.arpa", "pc.internal", "pc.tail1234.ts.net"] {
    check(OpeningWatch.homeHost(host), "\(host) is a home address")
}
for host in ["herdr.theworld.codes", "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2001:db8::1]", "local.example.com"] {
    check(!OpeningWatch.homeHost(host), "\(host) is a public address")
}

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("OpeningWatch: all checks passed")
