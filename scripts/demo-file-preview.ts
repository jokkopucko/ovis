export const DEMO_FILE_PREVIEW_SCRIPT = `<script>(${(() => {
  const demoFetch = window.fetch;
  const text = "# File preview\n\nA readable demo fixture.\n";
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const path = url.searchParams.get("path") ?? "";
    if (path === "README.md" || path.endsWith("/README.md")) {
      if (url.pathname.endsWith("/fs/stat")) return Promise.resolve(Response.json({
        path, name: "README.md", kind: "text", mime: "text/markdown", size: text.length,
      }));
      if (url.pathname.endsWith("/fs/file")) return Promise.resolve(new Response(text, { headers: { "content-type": "text/markdown" } }));
    }
    return demoFetch(input, init);
  };
}).toString()})();</script>`;
