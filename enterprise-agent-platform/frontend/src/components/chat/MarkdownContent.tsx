import {Children,isValidElement,type ComponentPropsWithoutRef,type ReactNode} from "react";
import ReactMarkdown,{type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import {useI18n} from "../../i18n";
import {highlight} from "../ui/beautiful";
import {CopyButton} from "./CopyButton";
import "katex/dist/katex.min.css";

const mathOptions={output:"htmlAndMathml" as const,trust:false,globalGroup:false,maxExpand:1000,maxSize:20};
function textOf(node:ReactNode):string {
 if(typeof node==="string"||typeof node==="number")return String(node);
 if(Array.isArray(node))return node.map(textOf).join("");
 return isValidElement<{children?:ReactNode}>(node)?textOf(node.props.children):"";
}
function CodeBlock({children}:ComponentPropsWithoutRef<"pre">) {
 const {t}=useI18n();
 const first=Children.toArray(children)[0];
 const code=isValidElement<{className?:string;children?:ReactNode}>(first)?first:null;
 const language=/(?:^|\s)language-([^\s]+)/.exec(code?.props.className||"")?.[1];
 const value=textOf(code?.props.children??children).replace(/\n$/,"");
 const lines=value.split("\n");
 // Beautiful UI Code Block: file-style header with a labelled copy, then a numbered, wrapping listing.
 return <figure className="wf-code-block bui-edge mx-0 my-3 min-w-0 overflow-hidden rounded-card bg-surface shadow-card">
  <figcaption className="flex h-10 items-center gap-2 border-b border-line pr-3 pl-3.5 text-[12.5px]">
   <span className="inline-flex min-w-0 items-center gap-[7px]">
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-3"><path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"/></svg>
    <span className="truncate font-mono leading-none text-ink">{language||t("chat.markdown.codeLabel")}</span>
   </span>
   <CopyButton value={value} kind="code" labelled/>
  </figcaption>
  <pre className="relative m-0 max-h-[32rem] overflow-auto bg-transparent p-0 py-3 font-mono text-[12.5px] leading-[1.65] text-ink-2" tabIndex={0}>
   <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-7 w-px bg-line"/>
   <code className={`${code?.props.className??""} block`}>{lines.map((line,index)=><span key={index} className="grid grid-cols-[28px_minmax(0,1fr)] items-start">
    <span aria-hidden="true" className="text-center text-[11px] text-ink-3 select-none">{index+1}</span>
    <span className="pr-4 pl-2 break-words whitespace-pre-wrap">{line?highlight(line):"\u200b"}</span>
   </span>)}</code>
  </pre>
 </figure>;
}
function Table({children,node:_node,...props}:ComponentPropsWithoutRef<"table">&{node?:unknown}) {
 const {t}=useI18n();
 return <div className="wf-markdown-table" role="region" aria-label={t("chat.markdown.tableLabel")} tabIndex={0}><table {...props}>{children}</table></div>;
}
function BlockedImage({alt}:{alt?:string}) {
 const {t}=useI18n();
 return <span role="note">{t("chat.markdown.imageBlocked",{alt:alt||t("chat.markdown.imageFallback")})}</span>;
}
function MathSpan({children,className,node:_node,...props}:ComponentPropsWithoutRef<"span">&{node?:unknown}) {
 const {t}=useI18n();
 const display=className?.split(/\s+/).includes("katex-display")??false;
 return <span {...props} className={className} role={display?"region":undefined} aria-label={display?t("chat.markdown.mathLabel"):undefined} tabIndex={display?0:undefined}>{children}</span>;
}
const components:Components={
 a:({children,node:_node,...props})=><a {...props} target="_blank" rel="noreferrer noopener">{children}</a>,
 pre:CodeBlock,table:Table,img:({alt})=><BlockedImage alt={alt||undefined}/>,span:MathSpan,
};
export function MarkdownContent({content}:{content:string}) {
 return <ReactMarkdown skipHtml components={components} remarkPlugins={[remarkGfm,remarkMath,remarkBreaks]} rehypePlugins={[[rehypeKatex,mathOptions]]}>{content}</ReactMarkdown>;
}
