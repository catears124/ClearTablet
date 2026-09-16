"use client";

import { useEffect, useRef, useState } from "react";
import { FLASH_COUNTER_URL } from "@/lib/flash-counter";

function readInstallTarget(tool: HTMLElement): "tablet" | "factory" {
  return tool.querySelector(".install-option.selected strong")?.textContent?.trim().toLowerCase() === "factory"
    ? "factory"
    : "tablet";
}

function successfulLineCount(tool: HTMLElement): number {
  return Array.from(tool.querySelectorAll(".log-lines > div"))
    .filter((node) => node.textContent?.includes("done. unplug and replug tablet to use.")).length;
}

export function FlashCounter({ buildSha }: { buildSha: string | null }) {
  const [count, setCount] = useState<number | null>(null);
  const seenSuccesses = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch(FLASH_COUNTER_URL, { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        const next = Number(body?.count);
        if (!cancelled && Number.isFinite(next)) setCount(next);
      } catch {
        // Stats are best-effort and must never affect flashing.
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const tool = document.querySelector<HTMLElement>("#tool");
    if (!tool) return;

    seenSuccesses.current = successfulLineCount(tool);

    const recordNewSuccesses = async () => {
      const total = successfulLineCount(tool);
      if (total <= seenSuccesses.current) return;

      const delta = total - seenSuccesses.current;
      seenSuccesses.current = total;
      const model = tool.querySelector<HTMLSelectElement>("select")?.value ?? "unknown";
      const target = readInstallTarget(tool);

      for (let index = 0; index < delta; index += 1) {
        try {
          const response = await fetch(FLASH_COUNTER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: crypto.randomUUID(),
              model,
              target,
              siteBuildSha: buildSha,
            }),
          });
          if (!response.ok) continue;
          const body = await response.json();
          const next = Number(body?.count);
          if (Number.isFinite(next)) setCount(next);
        } catch {
          // A failed counter update must never change the flash result.
        }
      }
    };

    const observer = new MutationObserver(() => void recordNewSuccesses());
    observer.observe(tool, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [buildSha]);

  useEffect(() => {
    const subtitle = document.querySelector<HTMLElement>("#tool .brand > small");
    if (!subtitle) return;
    subtitle.dataset.flashCounter = count === null
      ? "… successful flashes"
      : `${count} successful ${count === 1 ? "flash" : "flashes"}`;
  }, [count]);

  useEffect(() => {
    const tool = document.querySelector<HTMLElement>("#tool");
    if (!tool) return;

    const installTutorial = () => {
      const instructions = tool.querySelector<HTMLElement>(".install-view .instructions");
      if (!instructions || instructions.dataset.videoTutorial === "true") return;

      const link = document.createElement("a");
      link.href = "https://youtu.be/ynwQ3alOaRM";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Video Tutorial";

      instructions.replaceChildren(link);
      instructions.dataset.videoTutorial = "true";
    };

    installTutorial();
    const observer = new MutationObserver(installTutorial);
    observer.observe(tool, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return <style>{`.brand > small { font-size: 0; } .brand > small::after { content: attr(data-flash-counter); font-size: 0.85rem; }`}</style>;
}
