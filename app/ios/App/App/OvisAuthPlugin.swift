import AuthenticationServices
import Capacitor
import UIKit

/// Signing in to the account from the app (docs/account.md, "Signing in"; src/lib/account/native.ts).
/// GitHub (or Apple on the web flow) opens in an ASWebAuthenticationSession, which hands back the
/// `ovis://account/callback` address the account service redirects to; Sign in with Apple runs
/// natively, asks for no name and no email, and hands back its identity token for the
/// `apple_id_token` grant. The page finishes the sign-in itself; nothing here keeps a token.
/// Android's twin: app/android/app/src/main/java/sh/ovis/app/OvisAuthPlugin.java.
@objc(OvisAuthPlugin)
public class OvisAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "OvisAuthPlugin"
    public let jsName = "OvisAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInWithApple", returnType: CAPPluginReturnPromise)
    ]

    private var session: ASWebAuthenticationSession?
    private var appleCall: CAPPluginCall?

    @objc func authenticate(_ call: CAPPluginCall) {
        guard let address = call.getString("url"), let url = URL(string: address), url.scheme == "https" else {
            call.reject("Sign in at an https address", "invalid_url")
            return
        }
        DispatchQueue.main.async {
            self.session?.cancel()
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "ovis") { callback, error in
                self.session = nil
                if let callback = callback {
                    call.resolve(["url": callback.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.reject("The sign-in was cancelled", "cancelled")
                } else {
                    call.reject("The sign-in did not finish", "failed")
                }
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { self.session = nil; call.reject("The sign-in could not start", "failed") }
        }
    }

    @objc func signInWithApple(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("Sign in with a nonce", "invalid_nonce")
            return
        }
        DispatchQueue.main.async {
            self.appleCall?.reject("The sign-in was replaced", "cancelled")
            self.appleCall = call
            let request = ASAuthorizationAppleIDProvider().createRequest()
            // no name, no email: the account service keeps neither
            request.requestedScopes = []
            request.nonce = nonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = appleCall else { return }
        appleCall = nil
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.identityToken, let token = String(data: data, encoding: .utf8) else {
            call.reject("Apple sent no identity token", "failed")
            return
        }
        call.resolve(["idToken": token])
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = appleCall else { return }
        appleCall = nil
        if let error = error as? ASAuthorizationError, error.code == .canceled {
            call.reject("The sign-in was cancelled", "cancelled")
        } else {
            call.reject("The sign-in did not finish", "failed")
        }
    }

    private func anchor() -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor() }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { anchor() }
}
