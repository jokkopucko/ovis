import UIKit
import UserNotifications
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // before anything opens: the saved PCs as this build can open them
        PCStore.settleShell()
        // an alert's tap that launched the app: its PC is the one the first screen opens, at its pane
        if let response = connectionOptions.notificationResponse { OvisPushPlugin.tapped(response) }
        window?.rootViewController = HerdrBridgeViewController.first()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// Back in front: each SSH PC listens again where iOS took its socket, and a connection that no longer answers is
    /// made again before the page asks (OvisSsh); nothing typed is sent again.
    func sceneWillEnterForeground(_ scene: UIScene) {
        // a port another app took meanwhile leaves the web view's rule: the web view is built again without it
        OvisSsh.tunnels.wakeAll(lost: { DispatchQueue.main.async { HerdrBridgeViewController.reopen() } })
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
