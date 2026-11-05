package sh.ovis.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The PCs this app knows, kept in SharedPreferences, as PCStore in the iOS app keeps them in
 * UserDefaults. The WebView's cookies (a paired device's sign-in) live in its own store.
 */
final class PCStore {
    private static final String PREFS = "herdr";

    /** The address to open instead of the bare origin until a PC page loads: a pairing link keeps its code through Try again. In memory only, as it can hold that code. */
    static String pendingStart;

    /** Why the PC's page failed, for the error page: WebView's reason, or the HTTP status it answered. */
    static volatile String failure;

    /** Redirects in a row that made another origin the PC (MainActivity), so two servers that redirect to each other stop. */
    static volatile int redirects;

    /** Redirects in a row the app follows, in the WebView and in ovisOrigin; past it the error page says so. */
    static final int MAX_REDIRECTS = 5;

    /** How long ovisOrigin waits for each answer. */
    private static final int PROBE_TIMEOUT_MS = 5000;

    /** How long ovisOrigin may take in all, its redirects included: the screen stays blank meanwhile. */
    static final long PROBE_BUDGET_MS = 10000;

    /** More than /api/health ever answers. */
    private static final int PROBE_MAX_BYTES = 64 * 1024;

    /** The bridge protocols this app knows, the `bridge_protocol` /api/health?scope=bridge names (BRIDGE_PROTOCOL in shared/machines.ts). */
    static final int MIN_BRIDGE_PROTOCOL = 1;
    static final int MAX_BRIDGE_PROTOCOL = 1;

    /** JSON's null, which a Map cannot tell from a missing name. */
    static final Object JSON_NULL = new Object();

    /** Ends a probe's request at its deadline: read timeouts alone let a server that trickles go on. */
    private static final ScheduledExecutorService PROBE_DEADLINE = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "ovis-probe-deadline");
        thread.setDaemon(true);
        return thread;
    });

    private PCStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * PCs opened before, the latest first, each by its key: the origin of a PC opened at its own
     * address, or the scope of one opened through the Ovis relay (`https://app.ovis.sh/s/<server_id>/`),
     * as every relay PC shares the hosted shell's origin. Entries saved before relay PCs are origins
     * and stay as they are.
     */
    static List<String> saved(Context context) {
        List<String> list = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString("saved", "[]"));
            for (int i = 0; i < array.length(); i++) list.add(array.getString(i));
        } catch (org.json.JSONException ignored) {
            // a damaged list starts empty again
        }
        return list;
    }

    private static void setSaved(Context context, List<String> list) {
        prefs(context).edit().putString("saved", new JSONArray(list).toString()).apply();
    }

    /** Labels of saved PCs by key, from a relay pairing offer's name. */
    static JSONObject names(Context context) {
        try {
            return new JSONObject(prefs(context).getString("names", "{}"));
        } catch (JSONException damaged) {
            return new JSONObject();
        }
    }

    static void setName(Context context, String key, String name) {
        JSONObject names = names(context);
        try {
            if (name == null) names.remove(key);
            else names.put(key, name);
        } catch (JSONException notStored) {
            return;
        }
        prefs(context).edit().putString("names", names.toString()).apply();
    }

    /** The PC the app opens at launch, a key (see saved); null shows the connect screen. */
    static String current(Context context) {
        return prefs(context).getString("current", null);
    }

    static void setCurrent(Context context, String origin) {
        prefs(context).edit().putString("current", origin).apply();
    }

    /** The PC opened last, even after Change PC, for the pages that name it. */
    static String last(Context context) {
        return prefs(context).getString("last", null);
    }

    /** Makes the PC `key` the one to open; it joins the saved PCs only once a page of it loads (remember). */
    static void open(Context context, String key, String start) {
        prefs(context).edit().putString("current", key).putString("last", key).apply();
        pendingStart = start;
    }

    /** Puts the PC `key` first in the saved PCs: a page of it has loaded, so an address that never answered is not kept. */
    static void remember(Context context, String key) {
        List<String> list = saved(context);
        list.remove(key);
        list.add(0, key);
        setSaved(context, list);
    }

    static void forget(Context context, String key) {
        List<String> list = saved(context);
        list.remove(key);
        setSaved(context, list);
        setName(context, key, null);
        SharedPreferences.Editor edit = prefs(context).edit();
        if (key.equals(current(context))) edit.remove("current");
        if (key.equals(last(context))) edit.remove("last");
        edit.apply();
    }

    /**
     * The key of a PC opened through the Ovis relay: `scope`, when it is an http or https origin with a
     * path ending in `/` and `url` is on that origin within that path; null otherwise.
     */
    static String scopeKey(String scope, String url) {
        String origin = origin(scope);
        String path = rawPath(scope);
        if (origin == null || !origin.equals(origin(url)) || path.length() < 2 || !path.endsWith("/")) return null;
        return scope.equals(origin + path) && belongs(url, scope) ? scope : null;
    }

    /**
     * Whether `url` is a page of the PC `key`: on its origin, and for a relay PC within its scope, path
     * segment by path segment (`/s/A/` is not within `/s/AB/`) and only as a browser would load it
     * (cleanPath): `<scope>../<other>/` resolves to another PC. A PC saved by its origin takes any page of it.
     */
    static boolean belongs(String url, String key) {
        String origin = origin(url);
        if (origin == null || !origin.equals(origin(key))) return false;
        String scope = rawPath(key);
        if (scope.isEmpty() || scope.equals("/")) return true;
        String path = cleanPath(rawPath(url));
        return path != null && cleanPath(scope) != null && scope.endsWith("/") && (path.endsWith("/") ? path : path + "/").startsWith(scope);
    }

    /**
     * `path` (percent-encoded, as a URL carries it) when a browser loads it as written, else null: no
     * `.` or `..` segment, plain or percent-encoded (once or twice), no encoded `/` and no `\`, which a
     * browser reads as `/`. A page within a scope never needs any of them.
     */
    static String cleanPath(String path) {
        if (path == null || path.indexOf('\\') >= 0) return null;
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.contains("%2f") || lower.contains("%5c")) return null;
        String decoded = percentDecoded(path);
        if (decoded == null || decoded.indexOf('\\') >= 0) return null;
        String twice = decoded.toLowerCase(Locale.ROOT);
        if (twice.contains("%2e") || twice.contains("%2f") || twice.contains("%5c")) return null;
        for (String segment : decoded.split("/", -1)) {
            if (segment.equals(".") || segment.equals("..")) return null;
        }
        return path;
    }

    /** `text` with its percent escapes read as UTF-8, or null for a malformed escape or malformed UTF-8. */
    private static String percentDecoded(String text) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c != '%') {
                byte[] bytes = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(bytes, 0, bytes.length);
                continue;
            }
            if (i + 2 >= text.length()) return null;
            int high = Character.digit(text.charAt(i + 1), 16), low = Character.digit(text.charAt(i + 2), 16);
            if (high < 0 || low < 0 || text.charAt(i + 1) > 'f' || text.charAt(i + 2) > 'f') return null;
            out.write(high * 16 + low);
            i += 2;
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray()))
                .toString();
        } catch (java.nio.charset.CharacterCodingException malformed) {
            return null;
        }
    }

    /** The path, query and fragment the PC `key` opens at: a pairing link's on the PC's origin, else the PC's scope or root. */
    static String startPath(String start, String key) {
        String origin = origin(key);
        if (start == null || origin == null || !origin.equals(origin(start))) {
            String scope = rawPath(key);
            return scope.isEmpty() ? "/" : scope;
        }
        return startOn(origin, start).substring(origin.length());
    }

    private static String rawPath(String text) {
        try {
            String path = new URI(text).getRawPath();
            return path == null ? "" : path;
        } catch (URISyntaxException e) {
            return "";
        }
    }

    /**
     * The origin of the Ovis server that `target` leads to, or null. Asks `/api/health?scope=bridge`,
     * which Ovis answers to anyone so a client can find its gate, and follows at most MAX_REDIRECTS
     * redirects of that request: a sign-in page, another site, a loop or no answer is not Ovis. Only
     * such an origin may become the PC, the one origin that gets Capacitor's bridge. Gives up after
     * about `budgetMs` (PROBE_BUDGET_MS), however slowly the answers come, and adds each origin it asks,
     * in order, to `path`. Blocks: never call it on the main thread.
     */
    static String ovisOrigin(String target, long budgetMs, List<String> path) {
        long deadline = System.nanoTime() + budgetMs * 1_000_000L;
        String next = origin(target);
        for (int hops = 0; next != null && hops <= MAX_REDIRECTS; hops++) {
            long left = (deadline - System.nanoTime()) / 1_000_000L;
            if (left <= 0) return null;
            path.add(next);
            HttpURLConnection connection = null;
            ScheduledFuture<?> stop = null;
            try {
                URL health = new URL(next + "/api/health?scope=bridge");
                connection = (HttpURLConnection) health.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setConnectTimeout((int) Math.min(PROBE_TIMEOUT_MS, left));
                connection.setReadTimeout((int) Math.min(PROBE_TIMEOUT_MS, left));
                stop = PROBE_DEADLINE.schedule(connection::disconnect, left, TimeUnit.MILLISECONDS);
                connection.setRequestProperty("Accept", "application/json");
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    next = location == null ? null : origin(health.toURI().resolve(location).toString());
                    continue;
                }
                if (status != 200) return null;
                return answersAsOvis(json(text(connection.getInputStream(), deadline))) ? next : null;
            } catch (IOException | URISyntaxException | IllegalArgumentException notOvis) {
                return null;
            } finally {
                if (stop != null) stop.cancel(false);
                if (connection != null) connection.disconnect();
            }
        }
        return null;
    }

    /** Whether `answer` is /api/health?scope=bridge as Ovis gives it: `ok` true, an `auth` object and a bridge protocol this app knows. */
    static boolean answersAsOvis(Object answer) {
        if (!(answer instanceof Map)) return false;
        Map<?, ?> health = (Map<?, ?>) answer;
        Object version = health.get("bridge_protocol");
        return Boolean.TRUE.equals(health.get("ok")) && health.get("auth") instanceof Map
            && version instanceof BigInteger
            && ((BigInteger) version).compareTo(BigInteger.valueOf(MIN_BRIDGE_PROTOCOL)) >= 0
            && ((BigInteger) version).compareTo(BigInteger.valueOf(MAX_BRIDGE_PROTOCOL)) <= 0;
    }

    /**
     * The first origin of `path`, the way from the address being opened (`from`) to an Ovis server,
     * that went over plain http the app should not switch to on its own: a public address (the connect
     * screen warns before one, as `publicHttp` in app/web/shell.js) or any http after https. Null when
     * the whole way is fine.
     */
    static String insecureHop(String from, List<String> path) {
        boolean https = from != null && from.startsWith("https://");
        for (String hop : path) {
            if (hop.startsWith("https://")) https = true;
            else if (https || publicHttp(hop)) return hop;
        }
        return null;
    }

    private static final Pattern IPV4 = Pattern.compile("^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})$");
    private static final Pattern NUMBER_LABEL = Pattern.compile("[0-9]+|0[xX][0-9a-fA-F]*");
    private static final Pattern HOME_NAME = Pattern.compile(".*\\.(ts\\.net|local|lan|home\\.arpa|internal)$");

    /** Whether `origin` is plain http to an address outside a tailnet or a home network, as `publicHttp` in app/web/shell.js decides. */
    static boolean publicHttp(String origin) {
        if (origin == null || !origin.startsWith("http://")) return false;
        String host;
        try {
            host = new URI(origin).getHost();
        } catch (URISyntaxException e) {
            return true;
        }
        if (host == null) return true;
        host = host.replaceAll("^\\[|\\]$", "").toLowerCase(Locale.ROOT);
        // a host whose last label is a number is an IPv4 address to the web view in any form
        // (134744072, 010.0.0.1, 0x8.8.8.8), which shell.js sees rewritten: only a plain dotted quad
        // is judged here, any other form counts as public
        if (NUMBER_LABEL.matcher(host.substring(host.lastIndexOf('.') + 1)).matches()) {
            Matcher ipv4 = IPV4.matcher(host);
            if (!ipv4.matches()) return true;
            int[] part = new int[4];
            for (int i = 0; i < 4; i++) {
                part[i] = Integer.parseInt(ipv4.group(i + 1));
                if (part[i] > 255) return true;
            }
            int a = part[0], b = part[1];
            // 10/8, 127/8, 172.16/12, 192.168/16, link-local 169.254/16, and Tailscale's 100.64/10
            return !(a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127));
        }
        // ::1, unique local fc00::/7 (Tailscale's fd7a:115c:a1e0::/48 among them) and link-local fe80::/10
        if (host.contains(":")) return !(host.equals("::1") || host.matches("^f[cd].*") || host.matches("^fe[89ab].*"));
        // a one-word name (a MagicDNS short name, localhost) or a tailnet or home network name
        return host.contains(".") && !HOME_NAME.matcher(host).matches();
    }

    /**
     * Reads a JSON text (RFC 8259) strictly, where org.json takes unquoted names and stops before
     * whatever follows the value: the whole text is one value, names are quoted and come once per
     * object. Objects come as Maps, arrays as Lists, null as JSON_NULL, a number written without a
     * fraction or exponent as a BigInteger and any other as a BigDecimal. Throws
     * IllegalArgumentException for anything else.
     */
    static Object json(String text) {
        StrictJson reader = new StrictJson(text);
        Object value = reader.value();
        reader.space();
        if (reader.at != text.length()) throw reader.error();
        return value;
    }

    private static final class StrictJson {
        /** Deeper nesting than any health answer, and short of the stack a hostile answer could exhaust. */
        private static final int MAX_DEPTH = 32;
        private final String text;
        private int at;
        private int depth;

        StrictJson(String text) {
            this.text = text;
        }

        IllegalArgumentException error() {
            return new IllegalArgumentException("not JSON at " + at);
        }

        void space() {
            while (at < text.length() && " \t\n\r".indexOf(text.charAt(at)) >= 0) at++;
        }

        char next() {
            if (at >= text.length()) throw error();
            return text.charAt(at++);
        }

        void word(String word) {
            if (!text.startsWith(word, at)) throw error();
            at += word.length();
        }

        Object value() {
            space();
            if (at >= text.length()) throw error();
            char c = text.charAt(at);
            if (c == '{' || c == '[') {
                if (++depth > MAX_DEPTH) throw error();
                Object nested = c == '{' ? object() : array();
                depth--;
                return nested;
            }
            if (c == '"') return string();
            if (c == 't') { word("true"); return Boolean.TRUE; }
            if (c == 'f') { word("false"); return Boolean.FALSE; }
            if (c == 'n') { word("null"); return JSON_NULL; }
            if (c == '-' || (c >= '0' && c <= '9')) return number();
            throw error();
        }

        Map<String, Object> object() {
            at++;
            Map<String, Object> map = new LinkedHashMap<>();
            space();
            if (at < text.length() && text.charAt(at) == '}') {
                at++;
                return map;
            }
            while (true) {
                space();
                if (at >= text.length() || text.charAt(at) != '"') throw error();
                String name = string();
                if (map.containsKey(name)) throw error();
                space();
                if (next() != ':') throw error();
                map.put(name, value());
                space();
                char c = next();
                if (c == '}') return map;
                if (c != ',') throw error();
            }
        }

        List<Object> array() {
            at++;
            List<Object> list = new ArrayList<>();
            space();
            if (at < text.length() && text.charAt(at) == ']') {
                at++;
                return list;
            }
            while (true) {
                list.add(value());
                space();
                char c = next();
                if (c == ']') return list;
                if (c != ',') throw error();
            }
        }

        String string() {
            at++;
            StringBuilder out = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') return out.toString();
                if (c < 0x20) throw error();
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char escape = next();
                switch (escape) {
                    case '"': case '\\': case '/': out.append(escape); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        int code = 0;
                        for (int i = 0; i < 4; i++) {
                            // ASCII hex only: Character.digit also takes other scripts' digits and fullwidth letters
                            char hex = next();
                            int digit = hex >= '0' && hex <= '9' ? hex - '0' : hex >= 'a' && hex <= 'f' ? hex - 'a' + 10 : hex >= 'A' && hex <= 'F' ? hex - 'A' + 10 : -1;
                            if (digit < 0) throw error();
                            code = code * 16 + digit;
                        }
                        out.append((char) code);
                        break;
                    default: throw error();
                }
            }
        }

        Object number() {
            int start = at;
            if (text.charAt(at) == '-') at++;
            if (at < text.length() && text.charAt(at) == '0') at++;
            else digits();
            boolean integer = true;
            if (at < text.length() && text.charAt(at) == '.') {
                at++;
                digits();
                integer = false;
            }
            if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
                at++;
                if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) at++;
                digits();
                integer = false;
            }
            String token = text.substring(start, at);
            try {
                return integer ? new BigInteger(token) : new BigDecimal(token);
            } catch (NumberFormatException tooLarge) {
                throw error();
            }
        }

        void digits() {
            int start = at;
            while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
            if (at == start) throw error();
        }
    }

    /** `target`'s path, query and fragment on `origin`: a pairing link keeps its code when its server's /api/health redirected to another origin. */
    static String startOn(String origin, String target) {
        try {
            URI uri = new URI(target);
            String path = uri.getRawPath();
            return origin + (path == null || path.isEmpty() ? "/" : path) + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()) + (uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment());
        } catch (URISyntaxException e) {
            return origin + "/";
        }
    }

    private static String text(InputStream stream, long deadline) throws IOException {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) != -1; ) {
                out.write(buffer, 0, read);
                if (out.size() > PROBE_MAX_BYTES) throw new IOException("answer too long");
                // a body that trickles in ends here too, should the disconnect at the deadline not stop the read at once
                if (System.nanoTime() > deadline) throw new IOException("answer too slow");
            }
            // malformed UTF-8 is not JSON: a decoder that reports it, where toString would put in U+FFFD
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray()))
                .toString();
        }
    }

    /** scheme://host[:port] of a well-formed http or https address, the host in lowercase, or null: `http://pc:abc/` is refused, not saved for Capacitor to fail on at the next start. */
    static String origin(String text) {
        URI uri;
        try {
            uri = new URI(text).parseServerAuthority();
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? null : uri.getHost().toLowerCase(Locale.ROOT);
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https")) || host == null || host.isEmpty()) return null;
        return uri.getPort() == -1 ? scheme + "://" + host : scheme + "://" + host + ":" + uri.getPort();
    }
}
