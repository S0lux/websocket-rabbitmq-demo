import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatGateway } from './shared/chat.gateway';
import { RabbitmqService } from './shared/rabbitmq.service';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [ConfigModule.forRoot(), EventEmitterModule.forRoot()],
  providers: [ChatGateway, RabbitmqService],
})
export class AppModule {}
