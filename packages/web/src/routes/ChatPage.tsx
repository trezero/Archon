import { useParams } from 'react-router';
import { ChatInterface } from '@/components/chat/ChatInterface';

export function ChatPage(): React.ReactElement {
  const { '*': rawConversationId } = useParams();
  const conversationId = rawConversationId ? decodeURIComponent(rawConversationId) : undefined;

  return <ChatInterface key={conversationId ?? 'new'} conversationId={conversationId ?? 'new'} />;
}
