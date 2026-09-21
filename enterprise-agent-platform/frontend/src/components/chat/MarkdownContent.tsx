import {Children,isValidElement,type ComponentPropsWithoutRef,type ReactNode} from "react";
import ReactMarkdown,{type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import {useI18n} from "../../i18n";
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
 return <figure className="bui-code-block"><figcaption><span>{language||t("chat.markdown.codeLabel")}</span><CopyButton value={value} kind="code"/></figcaption><pre tabIndex={0} aria-label={language||t("chat.markdown.codeLabel")}><code className={code?.props.className}>{value.split("\n").map((line,index)=><span className="bui-code-line" key={index}><span className="bui-code-line-number" aria-hidden="true">{index+1}</span><span className="bui-code-line-text">{line}{"\n"}</span></span>)}</code></pre></figure>;
}
function Table({children,node:_node,...props}:ComponentPropsWithoutRef<"table">&{node?:unknown}) {
 const {t}=useI18n();
 return <div className="bui-markdown-table" role="region" aria-label={t("chat.markdown.tableLabel")} tabIndex={0}><table {...props}>{children}</table></div>;
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
