import UIKit
import WebKit

/// Full-screen WebView on the souldew server that runs inside the app (nodejs-mobile): the same page the desktop app and the
/// Android app show. Game Boy / Color / Advance / DS play in the browser emulator (WebAssembly); there is no Java for the
/// randomizer and no JIT for the 3DS on iOS.
final class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let port = 7373
    private static var nodeStarted = false
    private var web: WKWebView!
    private let message = UILabel()
    private var waiting = true

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isHidden = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // only for an error: while the server starts the screen stays black, the web app's own loader follows
        message.textColor = .white
        message.numberOfLines = 0
        message.textAlignment = .center
        message.isHidden = true
        message.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(message)
        NSLayoutConstraint.activate([
            message.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])

        if startNode() { poll() }
    }

    // MARK: the server

    private func fail(_ text: String) {
        waiting = false
        message.text = text
        message.isHidden = false
    }

    private func startNode() -> Bool {
        guard let app = Bundle.main.resourceURL?.appendingPathComponent("souldew-app"),
              FileManager.default.fileExists(atPath: app.appendingPathComponent("server/index.mjs").path) else {
            fail("souldew cannot start: the server files are missing from the app")
            return false
        }
        // Documents/souldew: Files > souldew > Library takes the games; the runs, saves and settings live there too
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("souldew")
        try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        setenv("PORT", String(port), 1)
        setenv("SLS_DATA_DIR", docs.path, 1)
        setenv("NO_OPEN", "1", 1)
        setenv("HOME", NSHomeDirectory(), 1)
        setenv("TMPDIR", NSTemporaryDirectory(), 1)
        if ViewController.nodeStarted { return true }
        ViewController.nodeStarted = true
        let args = ["node", app.appendingPathComponent("server/index.mjs").path]
        let thread = Thread { NodeRunner.startEngine(withArguments: args) }
        thread.name = "node"
        thread.stackSize = 4 * 1024 * 1024 // Node needs more than a default thread has
        thread.qualityOfService = .userInitiated
        thread.start()
        return true
    }

    private func poll() {
        guard waiting, let url = URL(string: "http://127.0.0.1:\(port)/api/status") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self = self, self.waiting else { return }
                if response is HTTPURLResponse {
                    self.waiting = false
                    self.web.isHidden = false
                    self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/")!))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.poll() }
                }
            }
        }.resume()
    }

    // MARK: the page

    /// Links to other sites open in Safari, not in the app's own page.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, let host = url.host, host != "127.0.0.1" {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    /// window.open(...) (target=_blank) goes to Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
