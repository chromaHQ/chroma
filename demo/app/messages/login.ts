import { Message, IMessage } from '@chroma/bridge';

@Message('login')
export class LoginMessage implements IMessage {
  handle<T, K>(params: T): Promise<K> | K {
    console.log(params);
    return Promise.resolve({ success: true } as K);
  }
}
