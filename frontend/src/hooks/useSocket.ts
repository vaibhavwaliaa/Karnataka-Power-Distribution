import { useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";

const WS_URL =
  (import.meta as any).env?.VITE_WS_URL || "https://kspdb-backend-hs6a.onrender.com";

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = io(WS_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });
  }
  return socket;
}

export function useSocket(
  event: string,
  handler: (data: any) => void
): void {
  const savedHandler = useRef(handler);

  useEffect(() => {
    savedHandler.current = handler;
  }, [handler]);

  useEffect(() => {
    const s = getSocket();
    const callback = (data: any) => savedHandler.current(data);
    s.on(event, callback);
    return () => {
      s.off(event, callback);
    };
  }, [event]);
}
