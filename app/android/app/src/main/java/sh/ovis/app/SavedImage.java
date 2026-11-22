package sh.ovis.app;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Base64;

final class SavedImage {
    /**
     * Far above any chat picture, and low enough that the bytes and their base64 copies stay a
     * small part of a phone's memory.
     */
    static final int MAX_BYTES = 20 * 1024 * 1024;

    /** Saves a page may start in one minute: a user tapping Download stays far below it. */
    static final int MAX_PER_MINUTE = 10;

    static final int MAX_PER_RUN = 100;

    static final long MAX_BYTES_PER_RUN = 500L * 1024 * 1024;

    /** A file name's limit is 255 bytes; this leaves room for Downloads' " (1)" on a repeat. */
    private static final int MAX_NAME_BYTES = 200;

    private SavedImage() {}

    static boolean isImageType(String type) {
        return type != null && type.matches("image/[A-Za-z0-9.+-]+");
    }

    static byte[] decode(String data) {
        if (data == null || data.isEmpty() || data.length() / 4 * 3 > MAX_BYTES + 3) return null;
        try {
            byte[] bytes = Base64.getDecoder().decode(data);
            return bytes.length == 0 || bytes.length > MAX_BYTES ? null : bytes;
        } catch (IllegalArgumentException notBase64) {
            return null;
        }
    }

    /**
     * `name`'s last path part, without characters a file name in Downloads cannot hold or a leading
     * dot (a hidden file), cut to MAX_NAME_BYTES in UTF-8 with its extension kept; "image" when
     * nothing is left.
     */
    static String fileName(String name) {
        String last = name == null ? "" : name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
        String clean = last.replaceAll("[\\p{Cntrl}:*?\"<>|]", "").trim().replaceFirst("^\\.+", "");
        if (utf8(clean) > MAX_NAME_BYTES) {
            int dot = clean.lastIndexOf('.');
            String extension = dot > 0 && clean.length() - dot <= 10 ? clean.substring(dot) : "";
            String stem = clean.substring(0, clean.length() - extension.length());
            int budget = MAX_NAME_BYTES - utf8(extension);
            int end = 0;
            while (end < stem.length()) {
                int next = stem.offsetByCodePoints(end, 1);
                if (utf8(stem.substring(0, next)) > budget) break;
                end = next;
            }
            clean = stem.substring(0, end) + extension;
        }
        return clean.isEmpty() ? "image" : clean;
    }

    private static int utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8).length;
    }

    /** Saves started in the last minute and in this run, so a page cannot write to Downloads without end. */
    static final class Budget {
        private final ArrayDeque<Long> started = new ArrayDeque<>();

        private int saves;

        private long bytes;

        synchronized boolean take(long now, int size) {
            while (!started.isEmpty() && now - started.peekFirst() >= 60_000) started.removeFirst();
            if (started.size() >= MAX_PER_MINUTE || saves >= MAX_PER_RUN || bytes + size > MAX_BYTES_PER_RUN) return false;
            started.addLast(now);
            saves++;
            bytes += size;
            return true;
        }
    }
}
