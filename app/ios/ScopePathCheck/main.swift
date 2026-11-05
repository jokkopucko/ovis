// Checks ScopePath (app/ios/App/App/ScopePath.swift), which the app target has no test target for.
// On a Mac: swiftc app/ios/App/App/ScopePath.swift app/ios/ScopePathCheck/main.swift -o /tmp/scope-path-check && /tmp/scope-path-check
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    if !ok { failures += 1; print("FAIL \(what)") }
}

/// The path PCStore.belongs reads from a URL; nil where Foundation takes no URL, which belongs refuses too.
func path(of text: String) -> String? {
    URL(string: text).flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: true)?.percentEncodedPath }
}
func within(_ text: String, _ scope: String) -> Bool {
    path(of: text).map { ScopePath.within($0, scope: scope) } ?? false
}

let scopeURL = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/"
let scope = "/s/0123456789abcdef0123456789abcdef/"
let other = "fedcba9876543210fedcba9876543210/"

for escape in [
    "../" + other, "../../outside/", "./x", "%2e%2e/" + other, "%2E%2E/" + other, ".%2e/" + other,
    "%252e%252e/" + other, "..%2f" + other, "x%2F..%2F..%2F" + other, "..%5c" + other, "x\\..\\..\\" + other,
] {
    check(!within(scopeURL + escape, scope), "refuses \(escape)")
}
check(!within("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef0/", scope), "refuses an id that starts with the scope's")
check(!ScopePath.within(scope, scope: "/s/0123456789abcdef0123456789abcdef"), "refuses a scope without its slash")
check(!ScopePath.within(scope, scope: scope + "../" + other), "refuses a scope that escapes itself")
check(within(scopeURL, scope), "takes the scope")
check(within("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef", scope), "takes the scope without its slash")
check(within(scopeURL + "~render?x=1#offer=eyJ2IjoxfQ", scope), "takes a deeper page with query and offer")
check(within(scopeURL + "deep/er/page.v2..html", scope), "takes dots inside a name")
check(within(scopeURL + "caf%C3%A9/", scope), "takes an encoded letter")
// Foundation takes a malformed escape as a literal `%` (`%25zz`), a name inside the scope; Java's URI refuses it
check(path(of: scopeURL + "%zz") == scope + "%25zz" && within(scopeURL + "%zz", scope), "keeps a malformed escape a name inside the scope")
check(ScopePath.clean("/s/a/b.c/") == "/s/a/b.c/" && ScopePath.clean("") == "", "keeps clean paths")
for bad in ["/..", "/.", "/a/%2e", "/a/%252E%252e/", "/a%2fb", "/a%5Cb", "/a\\b", "/a%", "/a%2", "/a%C3"] {
    check(ScopePath.clean(bad) == nil, "clean refuses \(bad)")
}

print(failures == 0 ? "scope-path-check: all passed" : "scope-path-check: \(failures) failed")
exit(failures == 0 ? 0 : 1)
