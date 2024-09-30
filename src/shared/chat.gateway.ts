// chat.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RabbitmqService } from './rabbitmq.service';
import { OnEvent } from '@nestjs/event-emitter';

@WebSocketGateway()
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private rabbitmqService: RabbitmqService) {}

  async handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    if (client.data.room) {
      await this.rabbitmqService.publishUserStatus(
        client.data.room,
        client.data.name,
        'left',
      );
    }
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    client: Socket,
    payload: { name: string; room: string },
  ) {
    const { name, room } = payload;
    client.data.name = name;
    client.data.room = room;

    await client.join(room);
    await this.rabbitmqService.publishUserStatus(room, name, 'joined');
  }

  @SubscribeMessage('chatMessage')
  async handleChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { message: string },
  ) {
    const { name, room } = client.data;
    const { message } = payload;

    await this.rabbitmqService.publishChatMessage(room, name, message);
  }

  @OnEvent('chat.message')
  handleBroadcastMessage(payload: {
    roomId: string;
    userId: string;
    message: string;
  }) {
    const { roomId, userId, message } = payload;
    this.server.to(roomId).emit('newMessage', { name: userId, message });
  }

  @OnEvent('user.status')
  async handleUserStatus(payload: {
    roomId: string;
    userId: string;
    status: string;
    instanceId: string;
  }) {
    const users = await this.rabbitmqService.getUsersInRoom(payload.roomId);
    if (payload.status === 'joined') {
      this.server.to(payload.roomId).emit('userJoined', {
        name: payload.userId,
        instanceId: payload.instanceId,
        users,
      });
    } else {
      this.server.to(payload.roomId).emit('userLeft', {
        name: payload.userId,
      });
    }
  }
}
