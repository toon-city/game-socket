import { io, Socket } from 'socket.io-client';
import {
  SocketEvent,
  UserJoinedPayload,
  UserLeftPayload,
  RemoteAvatarMovePayload,
  RemoteAvatarSayPayload,
  RemoteFurnitureMovePayload,
  RemoteFurniturePlacePayload,
  RemoteFurnitureRemovePayload,
  RemoteFurnitureRotatePayload,
  RemoteChatMessagePayload,
  RoomState,
  RoomErrorPayload,
  FurniturePlacePayload,
  FurnitureMovePayload,
  FurnitureRotatePayload,
  FurnitureRemovePayload,
} from '@toon-live/game-types';

// ─── Types ─────────────────────────────────────────────────────────────────────

type EventMap = {
  connected: [];
  disconnected: [];
  roomState: [state: RoomState];
  roomError: [error: RoomErrorPayload];
  userJoined: [payload: UserJoinedPayload];
  userLeft: [payload: UserLeftPayload];
  remoteAvatarMove: [payload: RemoteAvatarMovePayload];
  remoteAvatarSay: [payload: RemoteAvatarSayPayload];
  remoteFurnitureMove: [payload: RemoteFurnitureMovePayload];
  remoteFurniturePlace: [payload: RemoteFurniturePlacePayload];
  remoteFurnitureRemove: [payload: RemoteFurnitureRemovePayload];
  remoteFurnitureRotate: [payload: RemoteFurnitureRotatePayload];
  remoteChatMessage: [payload: RemoteChatMessagePayload];
};

type Listener<K extends keyof EventMap> = (...args: EventMap[K]) => void;

export interface GameSocketOptions {
  serverUrl: string;
  token: string;
  /** Throttle interval (ms) for avatar_move events. Default: 50 */
  moveThrottleMs?: number;
}

// ─── GameSocket ────────────────────────────────────────────────────────────────

/**
 * Thin adapter bridging Socket.IO and the rest of the application.
 *
 * Usage:
 * ```ts
 * const gs = new GameSocket({ serverUrl: 'http://localhost:3001', token });
 * gs.on('roomState', (state) => { … });
 * gs.connect();
 * gs.joinRoom('jardin');
 * // In avatar move callback from GameCore:
 * gs.sendAvatarMove('jardin', x, y);
 * ```
 */
export class GameSocket {
  private socket: Socket | null = null;
  private listeners = new Map<string, Set<Listener<any>>>();
  private readonly opts: Required<GameSocketOptions>;

  // Throttle state for avatar_move
  private lastMoveAt = 0;
  private pendingMove: { roomId: string; x: number; y: number; direction: number } | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GameSocketOptions) {
    this.opts = { moveThrottleMs: 50, ...opts };
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  connect(): void {
    if (this.socket?.connected) return;

    this.socket = io(this.opts.serverUrl, {
      auth: { token: this.opts.token },
      transports: ['websocket'],
    });

    this.socket.on('connect', () => this.emit('connected'));
    this.socket.on('disconnect', () => this.emit('disconnected'));

    this.socket.on(SocketEvent.ROOM_STATE, (p: RoomState) => this.emit('roomState', p));
    this.socket.on(SocketEvent.ROOM_ERROR, (p: RoomErrorPayload) => this.emit('roomError', p));
    this.socket.on(SocketEvent.USER_JOINED, (p: UserJoinedPayload) => this.emit('userJoined', p));
    this.socket.on(SocketEvent.USER_LEFT, (p: UserLeftPayload) => this.emit('userLeft', p));
    this.socket.on(SocketEvent.REMOTE_AVATAR_MOVE, (p: RemoteAvatarMovePayload) => this.emit('remoteAvatarMove', p));
    this.socket.on(SocketEvent.REMOTE_AVATAR_SAY, (p: RemoteAvatarSayPayload) => this.emit('remoteAvatarSay', p));
    this.socket.on(SocketEvent.REMOTE_FURNITURE_MOVE, (p: RemoteFurnitureMovePayload) => this.emit('remoteFurnitureMove', p));
    this.socket.on(SocketEvent.REMOTE_FURNITURE_PLACE, (p: RemoteFurniturePlacePayload) => this.emit('remoteFurniturePlace', p));
    this.socket.on(SocketEvent.REMOTE_FURNITURE_REMOVE, (p: RemoteFurnitureRemovePayload) => this.emit('remoteFurnitureRemove', p));
    this.socket.on(SocketEvent.REMOTE_FURNITURE_ROTATE, (p: RemoteFurnitureRotatePayload) => this.emit('remoteFurnitureRotate', p));
    this.socket.on(SocketEvent.REMOTE_CHAT_MESSAGE, (p: RemoteChatMessagePayload) => this.emit('remoteChatMessage', p));
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  // ── Room ─────────────────────────────────────────────────────────────────

  joinRoom(roomId: string): void {
    this.socket?.emit(SocketEvent.JOIN_ROOM, { roomId });
  }

  leaveRoom(roomId: string): void {
    this.socket?.emit(SocketEvent.LEAVE_ROOM, { roomId });
  }

  // ── Avatar ───────────────────────────────────────────────────────────────

  /**
   * Throttled avatar move — at most one packet per `moveThrottleMs`.
   * The last position during the throttle window is always flushed.
   */
  sendAvatarMove(roomId: string, x: number, y: number, direction: number): void {
    const now = Date.now();
    const elapsed = now - this.lastMoveAt;

    if (elapsed >= this.opts.moveThrottleMs) {
      this.lastMoveAt = now;
      this.socket?.emit(SocketEvent.AVATAR_MOVE, { roomId, x, y, direction });
    } else {
      this.pendingMove = { roomId, x, y, direction };
      if (!this.moveTimer) {
        this.moveTimer = setTimeout(() => {
          this.moveTimer = null;
          if (this.pendingMove) {
            const { roomId: rid, x: px, y: py, direction: pd } = this.pendingMove;
            this.pendingMove = null;
            this.lastMoveAt = Date.now();
            this.socket?.emit(SocketEvent.AVATAR_MOVE, { roomId: rid, x: px, y: py, direction: pd });
          }
        }, this.opts.moveThrottleMs - elapsed);
      }
    }
  }

  sendAvatarSay(roomId: string, text: string): void {
    this.socket?.emit(SocketEvent.AVATAR_SAY, { roomId, text });
  }

  // ── Furniture ────────────────────────────────────────────────────────────

  sendFurniturePlace(roomId: string, payload: FurniturePlacePayload): void {
    this.socket?.emit(SocketEvent.FURNITURE_PLACE, { roomId, ...payload });
  }

  sendFurnitureMove(roomId: string, payload: FurnitureMovePayload): void {
    this.socket?.emit(SocketEvent.FURNITURE_MOVE, { roomId, ...payload });
  }

  sendFurnitureRotate(roomId: string, payload: FurnitureRotatePayload): void {
    this.socket?.emit(SocketEvent.FURNITURE_ROTATE, { roomId, ...payload });
  }

  sendFurnitureRemove(roomId: string, payload: FurnitureRemovePayload): void {
    this.socket?.emit(SocketEvent.FURNITURE_REMOVE, { roomId, ...payload });
  }

  // ── Chat ─────────────────────────────────────────────────────────────────

  sendChatMessage(roomId: string, text: string): void {
    this.socket?.emit(SocketEvent.CHAT_MESSAGE, { roomId, text });
  }

  // ── Event bus ────────────────────────────────────────────────────────────

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as Listener<any>);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener as Listener<any>);
  }

  private emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    this.listeners.get(event)?.forEach((fn) => (fn as Function)(...args));
  }
}
