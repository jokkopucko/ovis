package sh.ovis.app;

import android.net.Uri;
import android.util.Base64;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The PC's direct carriers for the hosted shell (src/lib/relay/directSocket.ts; docs/relay.md, "Direct on
 * the same network"): a page on https cannot open plain `ws://`. Only the app's own origin may call it
 * (allowed), only `ws://<private IPv4>:<port>/v1/ws?v=1` opens (DirectSocket.carrier), at most two at once.
 * Frames go to the page in order as `{ id, kind, data }` (binary as base64); a socket whose messages the page
 * has not acknowledged pass 4 MiB or 16,384 is closed with 1009. Noise inside the channel proves the PC: the
 * address is only a hint. The iOS twin: app/ios/App/App/OvisDirectPlugin.swift.
 */
@CapacitorPlugin(name = "OvisDirect")
public class OvisDirectPlugin extends Plugin {
    static final String APP_ORIGIN = "https://app.ovis.sh";
    static final int MAX_SOCKETS = 2;
    static final int MAX_QUEUED_BYTES = 4 * 1024 * 1024;
    static final int MAX_QUEUED_MESSAGES = 16_384;

    private static final class Entry {
        DirectSocket socket;
        /** the page closed it: its closing handshake no longer takes one of the page's places */
        boolean closing;
        /** sizes of the messages sent to the page and not acknowledged yet, oldest first */
        final ArrayDeque<Integer> unacked = new ArrayDeque<>();
        long unackedBytes;
    }

    private final Map<String, Entry> sockets = new HashMap<>();
    /** counts the pages this plugin served (closeAll): an open asked by an earlier page opens nothing */
    private int pages;

    @Override
    public void load() {
        // a new page: the old one's sockets would hold both places and nobody reads them
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                closeAll();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        closeAll();
    }

    /**
     * Whether Capacitor's bridge on this WebView is its WebMessageListener, decided from Capacitor's own state.
     *
     * MessageHandler (Capacitor 8.5.3) installs exactly one of two bridges: a WebMessageListener for its origin
     * rules, whose callback takes only main-frame messages, or, when the feature is missing, the legacy bridge is
     * configured, or adding the listener throws, a JavaScript interface that every frame of every origin can call.
     * Only that listener callback ever sets its private field `javaScriptReplyProxy`; nothing clears it, and the
     * fallback never sets it. So a non-null proxy proves the listener is the bridge, and then no JavaScript
     * interface exists to call plugins from a frame. The page sets it with its first plugin call (directSocket.ts
     * adds its listeners before any open); the listener writes it before it hands the next call to the plugin
     * thread's queue, which orders the write before this read. Read by reflection, as Capacitor exposes no
     * accessor: a field that is missing or unreadable (another Capacitor version) refuses every call, as does
     * a null proxy.
     */
    private boolean listenerBridge() {
        try {
            java.lang.reflect.Field handlerField = com.getcapacitor.Bridge.class.getDeclaredField("msgHandler");
            handlerField.setAccessible(true);
            Object handler = handlerField.get(bridge);
            if (handler == null) return false;
            java.lang.reflect.Field proxyField = handler.getClass().getDeclaredField("javaScriptReplyProxy");
            proxyField.setAccessible(true);
            return proxyField.get(handler) != null;
        } catch (ReflectiveOperationException | RuntimeException unknown) {
            return false;
        }
    }

    /**
     * Whether the page calling is the app's own. Capacitor's listener bridge takes calls only from the main frame of
     * its origin rules (a PluginCall does not name the caller's frame or origin), and those rules are the hosted
     * shell's origin and the app's bundled pages only while a relay PC is open; `open` then checks the page on screen.
     * Without a proven listener bridge (listenerBridge) every call is refused.
     */
    private boolean allowed(PluginCall call) {
        if (!listenerBridge() || !APP_ORIGIN.equals(bridge.getServerUrl())) {
            call.reject("OvisDirect answers only the app's own page", "not_allowed");
            return false;
        }
        return true;
    }

    @PluginMethod
    public void open(PluginCall call) {
        if (!allowed(call)) return;
        int askedOn;
        synchronized (this) { askedOn = pages; }
        String[] carrier = DirectSocket.carrier(call.getString("url"));
        if (carrier == null) {
            call.reject("Only a direct carrier on a private address opens", "invalid_url");
            return;
        }
        // the page on screen, checked where the WebView lives: the bundled error page shares the bridge
        getActivity().runOnUiThread(() -> {
            String page = bridge.getWebView().getUrl();
            Uri url = page == null ? null : Uri.parse(page);
            if (url == null || !"https".equals(url.getScheme()) || !"app.ovis.sh".equals(url.getHost()) || (url.getPort() != -1 && url.getPort() != 443)) {
                call.reject("OvisDirect answers only the app's own page", "not_allowed");
                return;
            }
            String id = UUID.randomUUID().toString();
            Entry entry = new Entry();
            synchronized (this) {
                if (pages != askedOn) {
                    call.reject("The page that asked has left", "closed");
                    return;
                }
                int open = 0;
                for (Entry other : sockets.values()) if (!other.closing) open++;
                // closing ones end within DirectSocket's close wait; at most as many again may still be closing
                if (open >= MAX_SOCKETS || sockets.size() >= 2 * MAX_SOCKETS) {
                    call.reject("Two direct sockets are open already", "too_many");
                    return;
                }
                sockets.put(id, entry);
                entry.socket = new DirectSocket(carrier[0], Integer.parseInt(carrier[1]), listener(id));
            }
            JSObject result = new JSObject();
            result.put("id", id);
            // answered before the socket starts, so the page knows it before any of its events
            call.resolve(result);
            entry.socket.start();
        });
    }

    private DirectSocket.Listener listener(String id) {
        return new DirectSocket.Listener() {
            @Override
            public void onText(String text) {
                deliver(id, "text", text, text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
            }

            @Override
            public void onBinary(byte[] bytes) {
                deliver(id, "binary", Base64.encodeToString(bytes, Base64.NO_WRAP), bytes.length);
            }

            @Override
            public void onClose(int code, String reason, boolean failed) {
                // under the lock deliver queues its message in, so no message of the socket follows its close
                synchronized (OvisDirectPlugin.this) {
                    if (sockets.remove(id) == null) return;
                    if (failed) {
                        JSObject event = new JSObject();
                        event.put("id", id);
                        emit("error", event);
                    }
                    JSObject closed = new JSObject();
                    closed.put("id", id);
                    closed.put("code", code);
                    closed.put("reason", reason);
                    emit("close", closed);
                }
            }
        };
    }

    /**
     * To the page on the main thread, where Capacitor drops every listener when a page starts (BridgeWebViewClient
     * onPageStarted -> Bridge.reset): one thread, so the events of a socket keep the order its reader thread gave them.
     */
    private void emit(String event, JSObject data) {
        bridge.executeOnMainThread(() -> notifyListeners(event, data));
    }

    /** One message to the page, unless the page is that far behind: then the socket ends with 1009. */
    private void deliver(String id, String kind, String data, int size) {
        Entry entry;
        synchronized (this) {
            entry = sockets.get(id);
            if (entry == null) return;
            if (entry.unacked.size() + 1 <= MAX_QUEUED_MESSAGES && entry.unackedBytes + size <= MAX_QUEUED_BYTES) {
                entry.unacked.add(size);
                entry.unackedBytes += size;
                JSObject event = new JSObject();
                event.put("id", id);
                event.put("kind", kind);
                event.put("data", data);
                // queued while the socket is still listed: its close event (onClose) comes after
                emit("message", event);
                return;
            }
        }
        // its close event comes through onClose, with 1009
        entry.socket.abort(1009, "receive queue full");
    }

    @PluginMethod
    public void send(PluginCall call) {
        if (!allowed(call)) return;
        String id = call.getString("id");
        String kind = call.getString("kind");
        String data = call.getString("data");
        Entry entry;
        synchronized (this) { entry = id == null ? null : sockets.get(id); }
        if (entry == null || data == null) {
            call.reject("That socket is closed", "closed");
            return;
        }
        // too big for the send queue whatever it turns into: ends the socket as an overflow would, before converting it
        boolean text = "text".equals(kind);
        if (data.length() > (text ? DirectSocket.MAX_MESSAGE : (DirectSocket.MAX_MESSAGE + 2) / 3 * 4)) {
            entry.socket.abort(1009, "send queue full");
            call.resolve();
            return;
        }
        if (text) {
            entry.socket.sendText(data);
        } else if ("binary".equals(kind)) {
            byte[] bytes;
            try { bytes = Base64.decode(data, Base64.DEFAULT); } catch (IllegalArgumentException error) { call.reject("Binary data is base64", "invalid_frame"); return; }
            entry.socket.sendBinary(bytes);
        } else {
            call.reject("A frame is text or binary", "invalid_frame");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (!allowed(call)) return;
        String id = call.getString("id");
        Entry entry;
        synchronized (this) { entry = id == null ? null : sockets.get(id); }
        if (entry != null) {
            Integer code = call.getInt("code");
            String reason = call.getString("reason");
            synchronized (this) { entry.closing = true; }
            entry.socket.close(code == null ? 1000 : code, reason == null ? "" : reason);
        }
        call.resolve();
    }

    @PluginMethod
    public void ack(PluginCall call) {
        if (!allowed(call)) return;
        String id = call.getString("id");
        Integer messages = call.getInt("messages");
        synchronized (this) {
            Entry entry = id == null ? null : sockets.get(id);
            if (entry != null && messages != null) {
                for (int taken = 0; taken < messages && !entry.unacked.isEmpty(); taken++) entry.unackedBytes -= entry.unacked.poll();
            }
        }
        call.resolve();
    }

    /** A page left: its sockets end at once, without a closing handshake, so the next page has both places. */
    private void closeAll() {
        Entry[] open;
        synchronized (this) {
            pages++;
            open = sockets.values().toArray(new Entry[0]);
        }
        for (Entry entry : open) if (entry.socket != null) entry.socket.abort(1001, "page left");
    }
}
