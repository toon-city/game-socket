# game-socket

Client WebSocket STOMP pour le projet Toon City.

## Contenu

- Connexion et authentification au serveur STOMP (`game-server-java`)
- Gestion des subscriptions de salle
- Abstraction `GameSocket` avec reconnexion automatique
- Types des frames STOMP entrants/sortants

## Utilisation

```typescript
import { GameSocket } from '@toon-live/game-socket';

const socket = new GameSocket({ url: 'ws://localhost:8081/ws', token });
await socket.connect();
socket.joinRoom(roomId);
```

## Build

```bash
bun run build
```
