import { describe, expect, it } from "vitest";
import {
  createDownloader,
  DEFAULT_TRUNCATED_HEADER,
  downloadUrl,
  filenameFromDisposition,
  saveDownload,
  streamDownload,
} from "../../src/sdk/download.js";
import { SdkRequestError } from "../../src/sdk/errors.js";
import {
  type RawTransport,
  resolveTransport,
  setGlobalTransport,
} from "../../src/sdk/transport.js";

const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(enc.encode(chunk));
    },
  });
}

function transportFor(
  respond: (url: string, init: RequestInit) => Response,
  token: string | null = "tok-9",
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: RawTransport = {
    baseUrl: "http://api.test",
    basePath: "/api",
    getToken: () => token,
    fetch: (async (input: string, init: RequestInit) => {
      calls.push({ url: input, init });
      return respond(input, init);
    }) as unknown as typeof fetch,
  };
  return { transport, calls };
}

describe("downloadUrl", () => {
  const { transport } = transportFor(() => new Response(""));

  it("puts the path under the mount point and drops unset params", () => {
    expect(
      downloadUrl(transport, {
        path: "reports/summary/export",
        params: { format: "csv", from: "", to: undefined, page: 2, all: false, none: null },
      }),
    ).toBe("http://api.test/api/reports/summary/export?format=csv&page=2&all=false");
  });

  it("does not double the mount point of a path the server handed out", () => {
    expect(downloadUrl(transport, { path: "/api/files/f1" })).toBe("http://api.test/api/files/f1");
    expect(downloadUrl(transport, { path: "/files/f1" })).toBe("http://api.test/api/files/f1");
  });
});

describe("filenameFromDisposition", () => {
  it("reads the quoted, the bare and the UTF-8 forms", () => {
    expect(filenameFromDisposition('attachment; filename="summary.csv"')).toBe("summary.csv");
    expect(filenameFromDisposition("attachment; filename=report.xlsx")).toBe("report.xlsx");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%D8%AA%D9%82.csv")).toBe("تق.csv");
    expect(
      filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A; filename=\"plain.csv\""),
    ).toBe("plain.csv");
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

describe("createDownloader", () => {
  it("streams the body chunk by chunk, token in a header, and reports the truncation header", async () => {
    const { transport, calls } = transportFor(
      () =>
        new Response(streamOf(["a,b\n", "1,2\n", "3,4\n"]), {
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="summary.csv"',
            [DEFAULT_TRUNCATED_HEADER]: "1",
          },
        }),
    );
    const result = await createDownloader(transport)({
      path: "reports/summary/export",
      params: { format: "csv" },
    });

    expect(calls[0]?.url).toBe("http://api.test/api/reports/summary/export?format=csv");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer tok-9");
    expect(calls[0]?.init.credentials).toBe("omit");
    expect(result).toMatchObject({
      status: 200,
      filename: "summary.csv",
      contentType: "text/csv",
      truncated: true,
    });

    const reader = result.stream?.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = (await reader?.read()) ?? { value: undefined, done: true };
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    expect(chunks).toEqual(["a,b\n", "1,2\n", "3,4\n"]);
  });

  it("truncated only when the header is exactly 1; blob() yields the whole body", async () => {
    for (const value of ["0", "", "true"]) {
      const { transport } = transportFor(
        () => new Response("x,y\n", { headers: { [DEFAULT_TRUNCATED_HEADER]: value } }),
      );
      expect((await createDownloader(transport)({ path: "x" })).truncated).toBe(false);
    }
    const { transport } = transportFor(() => new Response("x,y\n"));
    const result = await createDownloader(transport)({ path: "x" });
    expect(result.truncated).toBe(false);
    expect(result.filename).toBeNull();
    expect(await (await result.blob()).text()).toBe("x,y\n");
  });

  it("the truncation header name is configurable", async () => {
    const { transport } = transportFor(
      () =>
        new Response("x", { headers: { "x-rows-capped": "1", [DEFAULT_TRUNCATED_HEADER]: "1" } }),
    );
    const result = await createDownloader(transport, { truncatedHeader: "x-rows-capped" })({
      path: "x",
    });
    expect(result.truncated).toBe(true);
    const other = await createDownloader(
      transportFor(() => new Response("x", { headers: { [DEFAULT_TRUNCATED_HEADER]: "1" } }))
        .transport,
      { truncatedHeader: "x-rows-capped" },
    )({ path: "x" });
    expect(other.truncated).toBe(false);
  });

  it("maps a refusal to an SdkRequestError carrying the server code", async () => {
    const { transport } = transportFor(() =>
      Response.json({ code: "reports.forbidden", message: "no" }, { status: 403 }),
    );
    const error = await createDownloader(transport)({ path: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SdkRequestError);
    expect(error).toMatchObject({ code: "reports.forbidden", status: 403, message: "no" });
  });

  it("falls back to http.<status> when the error body is not JSON", async () => {
    const { transport } = transportFor(() => new Response("<html>", { status: 502 }));
    await expect(createDownloader(transport)({ path: "x" })).rejects.toMatchObject({
      code: "http.502",
      status: 502,
    });
  });

  it("refuses without a token and never touches the network", async () => {
    const { transport, calls } = transportFor(() => new Response(""), null);
    await expect(createDownloader(transport)({ path: "x" })).rejects.toMatchObject({
      code: "arc.unauthorized",
      status: 401,
    });
    expect(calls).toHaveLength(0);
  });

  it("reports a dropped connection as status 0 and rethrows an abort untouched", async () => {
    const dropped: RawTransport = {
      baseUrl: "http://api.test",
      basePath: "/api",
      getToken: () => "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    };
    await expect(createDownloader(dropped)({ path: "x" })).rejects.toMatchObject({
      code: "network",
      status: 0,
    });
    const aborted: RawTransport = {
      ...dropped,
      fetch: (async () => {
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
    };
    await expect(createDownloader(aborted)({ path: "x" })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("streamDownload and saveDownload", () => {
  it("streamDownload needs initSDK and then uses the global transport", async () => {
    const { transport } = transportFor(() => new Response("ok"));
    setGlobalTransport(
      resolveTransport({
        baseUrl: transport.baseUrl,
        basePath: "/api",
        getToken: () => "g",
        fetch: transport.fetch,
      }),
    );
    expect(await (await (await streamDownload({ path: "x" })).blob()).text()).toBe("ok");
  });

  it("saveDownload needs a browser document", async () => {
    const result = await createDownloader(transportFor(() => new Response("x")).transport)({
      path: "x",
    });
    await expect(saveDownload(result, "f.csv")).rejects.toThrow(/browser document/);
  });
});
