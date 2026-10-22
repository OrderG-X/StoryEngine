import { useRef } from "react";
import { usePresence } from "../../hooks/usePresence.js";

/** 顶层提示条：换一句就重播进场；消失时先淡出再卸（以前是一下没了）。 */
export function AppToast({ message }: { readonly message: string | null }) {
  const presence = usePresence<HTMLDivElement>(Boolean(message));
  const last = useRef(message);
  if (message) last.current = message;
  if (!presence.mounted || !last.current) return null;
  return (
    <div key={last.current} ref={presence.ref} className="app-toast" data-closing={presence.closing || undefined}>
      {last.current}
    </div>
  );
}
