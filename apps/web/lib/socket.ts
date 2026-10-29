import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@chessarena/shared";

export type ArenaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Fournit les credentials à CHAQUE (re)connexion : un JWT expiré est renouvelé automatiquement. */
export type AuthProvider = () => Promise<Record<string, unknown>>;

let socket: ArenaSocket | null = null;

/** Un seul socket par onglet, partagé par tous les composants. */
export function getSocket(getAuth: AuthProvider): ArenaSocket {
  if (socket) return socket;
  const s: ArenaSocket = io(process.env.NEXT_PUBLIC_GAME_SERVER_URL ?? "http://localhost:4000", {
    transports: ["websocket"],
    autoConnect: true,
    auth: (cb) => void getAuth().then(cb, () => cb({})),
    reconnectionDelay: 250,
    reconnectionDelayMax: 2_000,
  });
  // Sonde de latence du serveur (ADR-8) : répondre IMMÉDIATEMENT, sans travail.
  s.on("lag:probe", (_serverTs, ack) => ack(Date.now()));
  socket = s;
  return s;
}

export function resetSocketForTests(): void {
  socket?.disconnect();
  socket = null;
}
