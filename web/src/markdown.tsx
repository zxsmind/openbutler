import { Fragment, createElement, useMemo, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

// Render tokens as React nodes: model-supplied HTML is always escaped.
function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => {
    const children = 'tokens' in token && token.tokens ? renderTokens(token.tokens) : 'text' in token ? token.text : null;
    let content: ReactNode;
    switch (token.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading':
        content = createElement(`h${token.depth}`, null, children);
        break;
      case 'paragraph':
        content = <p>{children}</p>;
        break;
      case 'strong':
        content = <strong>{children}</strong>;
        break;
      case 'em':
        content = <em>{children}</em>;
        break;
      case 'del':
        content = <del>{children}</del>;
        break;
      case 'codespan':
        content = <code>{token.text}</code>;
        break;
      case 'code':
        content = (
          <pre className="code">
            <code>{token.text}</code>
          </pre>
        );
        break;
      case 'blockquote':
        content = <blockquote>{children}</blockquote>;
        break;
      case 'br':
        content = <br />;
        break;
      case 'hr':
        content = <hr />;
        break;
      case 'link':
        content = /^(https?:|mailto:)/i.test(token.href) ? (
          <a href={token.href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        );
        break;
      case 'image':
        content = <span>{token.text || 'Image'}</span>;
        break;
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, i) => (
          <li key={i}>
            {item.task ? <input type="checkbox" checked={!!item.checked} disabled /> : null}
            {renderTokens(item.tokens)}
          </li>
        ));
        content = list.ordered ? <ol start={Number(list.start) || 1}>{items}</ol> : <ul>{items}</ul>;
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        content = (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {table.header.map((cell, i) => (
                    <th key={i}>{renderTokens(cell.tokens)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{renderTokens(cell.tokens)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        break;
      }
      default:
        content = children ?? token.raw;
    }
    return <Fragment key={index}>{content}</Fragment>;
  });
}

export function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => marked.lexer(text), [text]);
  return <div className="markdown">{renderTokens(tokens)}</div>;
}
