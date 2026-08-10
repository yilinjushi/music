import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpstreamDeadlineError,
  fetchUpstreamWithDeadline,
} from "./upstream-deadline";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchUpstreamWithDeadline", () => {
  it("aborts when response headers never arrive", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    const request = fetchUpstreamWithDeadline(
      "https://provider.example/search",
      {},
      (response) => response.json(),
      { responseType: "json", deadlineMs: 25, fetcher }
    );
    const rejection = expect(request).rejects.toBeInstanceOf(
      UpstreamDeadlineError
    );

    await vi.advanceTimersByTimeAsync(26);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the same absolute deadline while reading the body", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
    });
    const fetcher = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(body, { headers: { "Content-Type": "application/json" } })
      );
    }) as typeof fetch;

    const request = fetchUpstreamWithDeadline(
      "https://provider.example/search",
      {},
      (response) => response.json(),
      { responseType: "json", deadlineMs: 25, fetcher }
    );
    const rejection = expect(request).rejects.toBeInstanceOf(
      UpstreamDeadlineError
    );

    await vi.advanceTimersByTimeAsync(26);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("returns a fully consumed result before the deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true })) as typeof fetch;

    await expect(
      fetchUpstreamWithDeadline(
        "https://provider.example/search",
        {},
        (response) => response.json(),
        { responseType: "json", deadlineMs: 25, fetcher }
      )
    ).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
      })
    ) as typeof fetch;

    await expect(
      fetchUpstreamWithDeadline(
        "https://provider.example/search",
        {},
        (response) => response.json(),
        { responseType: "json", fetcher }
      )
    ).rejects.toMatchObject({ name: "UpstreamBodyLimitError" });
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("enforces the cumulative byte limit without Content-Length", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(body)) as typeof fetch;

    await expect(
      fetchUpstreamWithDeadline(
        "https://provider.example/binary",
        {},
        (response) => response.arrayBuffer(),
        { responseType: "binary", fetcher }
      )
    ).rejects.toMatchObject({ name: "UpstreamBodyLimitError" });
    expect(cancelled).toBe(true);
  });

  it("keeps the deadline active while a bounded stream stalls", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;
    const request = fetchUpstreamWithDeadline(
      "https://provider.example/search",
      {},
      (response) => response.json(),
      { responseType: "json", deadlineMs: 25, fetcher }
    );
    const rejection = expect(request).rejects.toBeInstanceOf(
      UpstreamDeadlineError
    );

    await vi.advanceTimersByTimeAsync(26);
    await rejection;
    expect(cancelled).toBe(true);
  });

  it("cancels an ignored body for a header-only upstream request", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { headers: { Location: "https://safe.example/" } })
      ) as typeof fetch;

    await expect(
      fetchUpstreamWithDeadline(
        "https://provider.example/short-link",
        { redirect: "manual" },
        (response) => response.headers.get("location"),
        { responseType: "none", fetcher }
      )
    ).resolves.toBe("https://safe.example/");
    expect(cancelled).toBe(true);
  });
});
