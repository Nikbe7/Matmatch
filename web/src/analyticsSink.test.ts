import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAnalyticsSink } from "./analyticsSink";

// Unit-level: exercises the sink's buffering and flush behaviour directly, without
// going through setAnalyticsSink/App.tsx wiring (issue #91).

function mealChosen(templateId: string) {
  return { name: "meal_chosen" as const, templateId, rerollDepth: 0 };
}

describe("createHttpAnalyticsSink", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caps the buffer and drops the oldest events, not the newest", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const handle = createHttpAnalyticsSink("token-123");
    // 55 taps against a cap of 50 — the first 5 must not survive to the flush.
    for (let i = 0; i < 55; i++) {
      handle.sink(mealChosen(`dish-${i}`));
    }
    handle.flush();
    handle.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      events: { event: { templateId: string } }[];
    };

    expect(body.events).toHaveLength(50);
    expect(body.events[0]!.event.templateId).toBe("dish-5");
    expect(body.events.at(-1)!.event.templateId).toBe("dish-54");
  });

  it("drops a batch on a failed flush without throwing, and keeps accepting new events", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const handle = createHttpAnalyticsSink("token-123");
    handle.sink(mealChosen("kycklinggryta"));

    expect(() => handle.flush()).not.toThrow();
    // The rejected fetch promise is handled inside flush(); let it settle before
    // asserting nothing propagated to the caller.
    await Promise.resolve();
    await Promise.resolve();

    // The failed batch is gone (dropped, not retried) — a second flush call sends
    // nothing further because the buffer is empty, proving the sink is still in a
    // usable state after a failure rather than stuck or re-throwing.
    fetchMock.mockClear();
    handle.flush();
    expect(fetchMock).not.toHaveBeenCalled();

    // And the sink still accepts new events — a broken transport never stops the
    // interaction that produces them.
    expect(() => handle.sink(mealChosen("fisksoppa"))).not.toThrow();
    handle.stop();
  });

  it("does not call fetch when flushed with nothing buffered", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const handle = createHttpAnalyticsSink("token-123");
    handle.flush();
    handle.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flushes on pagehide", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const handle = createHttpAnalyticsSink("token-123");
    handle.sink(mealChosen("kycklinggryta"));
    window.dispatchEvent(new Event("pagehide"));
    handle.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stop() removes the pagehide listener, so a later pagehide does not flush", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const handle = createHttpAnalyticsSink("token-123");
    handle.sink(mealChosen("kycklinggryta"));
    handle.stop();
    window.dispatchEvent(new Event("pagehide"));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
