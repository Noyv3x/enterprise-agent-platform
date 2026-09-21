import { lazy, Suspense } from "react";
const MarkdownContent = lazy(() => import("./MarkdownContent").then(module => ({default:module.MarkdownContent})));
export function MessageBody({content}:{content:string}) {
 return <div className="bui-message-prose"><Suspense fallback={<span className="bui-message-plaintext">{content}</span>}><MarkdownContent content={content}/></Suspense></div>;
}
