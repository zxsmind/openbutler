import { Brand } from './ui.js';
import './conversation-welcome.css';

/** Empty conversation content; independent from the message composer. */
export function ConversationWelcome({ projectName }: { projectName?: string }) {
  return (
    <section className="conversation-welcome" aria-label="New conversation">
      <Brand large />
      <h1>
        {projectName ? (
          <>
            <span>{projectName}</span> project: what should we build?
          </>
        ) : (
          'What do you want to do?'
        )}
      </h1>
    </section>
  );
}
