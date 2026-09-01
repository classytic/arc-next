"use client";

/**
 * Elect ONE leader tab per browser, so a shared resource is held once.
 *
 * A browser allows only ~6 concurrent connections per origin on HTTP/1.1, so a
 * per-tab stream lets a user with several tabs starve their own app — and it
 * multiplies every reconnect against one server-side limit.
 *
 * Modelled on Odoo's `multi_tab_fallback_service` (addons/bus): the leader
 * writes a heartbeat on an interval, any tab may claim leadership once that
 * heartbeat goes stale, and a closing tab releases it immediately. localStorage
 * is the coordination channel because it is synchronous, origin-scoped and
 * present everywhere — a SharedWorker is tidier but absent in several browsers,
 * which is why Odoo keeps this path too.
 */

import { useEffect, useState } from "react";

/** Leader refresh interval. Comfortably under STALE_MS so a live leader is never displaced. */
const HEARTBEAT_MS = 1500;
/** A heartbeat older than this means the holder is gone (crashed tab, killed process). */
const STALE_MS = 5000;
/** How often a follower checks whether leadership is up for grabs. */
const CHECK_MS = 2000;

interface LeaderRecord {
  id: string;
  ts: number;
}

function readRecord(key: string): LeaderRecord | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LeaderRecord;
    return typeof parsed?.id === "string" && typeof parsed?.ts === "number" ? parsed : null;
  } catch {
    // Unparseable or blocked (private mode, disabled storage) — treat as vacant.
    return null;
  }
}

function writeRecord(key: string, record: LeaderRecord): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * `true` in exactly one tab at a time (per `key`).
 *
 * When storage is unavailable every tab reports leader. That is deliberate: a
 * degraded browser must not lose the feature entirely, and the server-side
 * concurrency cap is the backstop for the duplicate connections it allows.
 */
export function useTabLeader(options: { key: string; enabled?: boolean }): boolean {
  const { key, enabled = true } = options;
  const [isLeader, setIsLeader] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof localStorage === "undefined") {
      setIsLeader(false);
      return;
    }

    const storageKey = `arc-next.leader.${key}`;
    const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let leading = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const claimOrRenew = () => {
      const now = Date.now();
      const held = readRecord(storageKey);
      const vacant = !held || now - held.ts > STALE_MS;
      const mine = held?.id === tabId;

      if (mine || vacant) {
        /**
         * Last write wins. Two tabs can claim a vacant slot in the same tick;
         * the loser observes a foreign id on its next pass and steps down, so
         * the overlap is bounded by one interval rather than persisting.
         */
        if (writeRecord(storageKey, { id: tabId, ts: now })) {
          const reread = readRecord(storageKey);
          const won = reread?.id === tabId;
          if (won !== leading) {
            leading = won;
            setIsLeader(won);
          }
        } else if (!leading) {
          // Storage unavailable — degrade to "everyone leads", never "nobody".
          leading = true;
          setIsLeader(true);
        }
      } else if (leading) {
        leading = false;
        setIsLeader(false);
      }

      timer = setTimeout(claimOrRenew, leading ? HEARTBEAT_MS : CHECK_MS);
    };

    /** Release immediately so a sibling promotes now rather than after STALE_MS. */
    const release = () => {
      if (!leading) return;
      const held = readRecord(storageKey);
      if (held?.id === tabId) {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // Nothing to do — the record simply expires.
        }
      }
    };

    claimOrRenew();
    window.addEventListener("pagehide", release);

    return () => {
      if (timer) clearTimeout(timer);
      release();
      window.removeEventListener("pagehide", release);
    };
  }, [key, enabled]);

  return isLeader;
}
