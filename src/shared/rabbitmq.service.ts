import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import amqp, { Channel, ChannelWrapper } from 'amqp-connection-manager';
import { IAmqpConnectionManager } from 'amqp-connection-manager/dist/types/AmqpConnectionManager';
import { ConsumeMessage } from 'amqplib';

@Injectable()
export class RabbitmqService implements OnModuleInit {
  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
  ) {}
  instanceId: string;
  private rabbitmqServer: IAmqpConnectionManager;
  private rabbitmqChannel;
  private onlineUsers: Map<string, Set<string>> = new Map();
  private requestCallbacks: Map<
    string,
    (instanceId: string, users: string[]) => void
  > = new Map();

  async onModuleInit() {
    this.instanceId = Math.random().toString(36).substring(2, 15);

    this.rabbitmqServer = amqp.connect([
      this.configService.get('RABBITMQ_URI'),
    ]);

    this.rabbitmqChannel = this.rabbitmqServer.createChannel({
      json: true,
      setup: async (channel: Channel) => {
        await Promise.all([
          channel.assertExchange('room_events', 'fanout'),
          channel.assertExchange('user_requests', 'fanout'),
          channel.assertExchange('user_responses', 'direct'),
          channel.assertExchange('chat_messages', 'fanout'),
        ]);

        const { queue: eventQueue } = await channel.assertQueue('', {
          exclusive: true,
        });
        const { queue: requestQueue } = await channel.assertQueue('', {
          exclusive: true,
        });
        const { queue: responseQueue } = await channel.assertQueue(
          this.instanceId,
          { exclusive: true },
        );
        const { queue: chatQueue } = await channel.assertQueue('', {
          exclusive: true,
        });

        await Promise.all([
          channel.bindQueue(eventQueue, 'room_events', ''),
          channel.bindQueue(requestQueue, 'user_requests', ''),
          channel.bindQueue(responseQueue, 'user_responses', this.instanceId),
          channel.bindQueue(chatQueue, 'chat_messages', ''),
        ]);

        channel.consume(eventQueue, this.handleRoomEvent.bind(this));
        channel.consume(requestQueue, this.handleUserRequest.bind(this));
        channel.consume(responseQueue, this.handleUserResponse.bind(this));
        channel.consume(chatQueue, this.handleChatMessage.bind(this));
      },
    });
  }

  private handleRoomEvent(msg: ConsumeMessage | null) {
    if (msg) {
      const parsedJsonString = JSON.parse(msg.content.toString());
      const parsedObj = JSON.parse(parsedJsonString);
      const { roomId, userId, status, instanceId } = parsedObj;
      this.updateUserStatus(roomId, userId, status, instanceId);
      this.rabbitmqChannel.ack(msg);
    }
  }

  private handleUserRequest(msg: ConsumeMessage | null) {
    if (msg) {
      const parsedJsonString = JSON.parse(msg.content.toString());
      const parsedObj = JSON.parse(parsedJsonString);

      const { requestId, roomId } = parsedObj;
      const users = Array.from(this.onlineUsers.get(roomId) || []);

      this.rabbitmqChannel.publish(
        'user_responses',
        msg.properties.replyTo,
        JSON.stringify({
          requestId,
          instanceId: this.instanceId,
          users,
        }),
      );

      this.rabbitmqChannel.ack(msg);
    }
  }

  private async handleUserResponse(msg: ConsumeMessage | null) {
    if (msg) {
      const parsedJsonString = JSON.parse(msg.content.toString());
      const parsedObj = JSON.parse(parsedJsonString);

      const { requestId, instanceId, users } = parsedObj;
      const callback = this.requestCallbacks.get(requestId);
      if (callback) {
        callback(instanceId, users);
      }
      this.rabbitmqChannel.ack(msg);
    }
  }

  private handleChatMessage(msg: ConsumeMessage | null) {
    if (msg) {
      const parsedJsonString = JSON.parse(msg.content.toString());
      const parsedObj = JSON.parse(parsedJsonString);
      const { roomId, userId, message } = parsedObj;
      this.eventEmitter.emit('chat.message', { roomId, userId, message });
      this.rabbitmqChannel.ack(msg);
    }
  }

  private updateUserStatus(
    roomId: string,
    userId: string,
    status: 'joined' | 'left',
    instanceId: string,
  ) {
    if (!this.onlineUsers.has(roomId)) {
      this.onlineUsers.set(roomId, new Set());
    }
    const roomUsers = this.onlineUsers.get(roomId)!;

    if (status === 'joined') {
      roomUsers.add(userId);
    } else if (status === 'left') {
      roomUsers.delete(userId);
    }

    this.eventEmitter.emit('user.status', {
      roomId,
      userId,
      status,
      instanceId,
    });
  }

  async publishUserStatus(
    roomId: string,
    userId: string,
    status: 'joined' | 'left',
  ) {
    const message = JSON.stringify({
      roomId,
      userId,
      status,
      instanceId: this.instanceId,
    });
    await this.rabbitmqChannel.publish('room_events', '', message);
  }

  async publishChatMessage(roomId: string, userId: string, message: string) {
    const payload = JSON.stringify({ roomId, userId, message });
    await this.rabbitmqChannel.publish('chat_messages', '', payload);
  }

  async getUsersInRoom(roomId: string): Promise<string[]> {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).substring(2, 15);
      const allUsers = new Set<string>();
      let responseCount = 0;
      const expectedResponses = parseInt(
        this.configService.getOrThrow<string>('INSTANCES_NUMBER'),
      );

      const callback = (instanceId: string, users: string[]) => {
        users.forEach((user) => allUsers.add(user));
        responseCount++;
        if (responseCount === expectedResponses) {
          this.requestCallbacks.delete(requestId);
          resolve(Array.from(allUsers));
        }
      };

      this.requestCallbacks.set(requestId, callback);

      this.rabbitmqChannel.publish(
        'user_requests',
        '',
        JSON.stringify({
          requestId,
          roomId,
        }),
        { replyTo: this.instanceId },
      );

      // Set a timeout in case not all instances respond
      setTimeout(() => {
        if (this.requestCallbacks.has(requestId)) {
          this.requestCallbacks.delete(requestId);
          resolve(Array.from(allUsers));
        }
      }, 5000);
    });
  }
}
