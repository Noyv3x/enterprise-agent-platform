# Source guide

## Hierarchy
1. **Primary:** statutes/regulations and official notices (国家法律法规数据库 flk.npc.gov.cn, 各部委/地方政府官网, 政府公报), statistics (国家统计局 stats.gov.cn, 行业主管部门年鉴, World Bank/OECD/IMF), company filings (巨潮资讯 cninfo.com.cn, 上交所/深交所/北交所, 港交所披露易, SEC EDGAR), standards bodies (全国标准信息公共服务平台, ISO/IEC), patents (国家知识产权局, WIPO PATENTSCOPE, Google Patents), court records (中国裁判文书网 and 人民法院案例库 where accessible), original papers and datasets, official product documentation.
2. **Credible secondary:** review articles and meta-analyses, 权威媒体 (新华社, 人民日报, 财新, 第一财经…) with named sources, industry associations, 研究院/智库报告 with disclosed method.
3. **Weak/contextual:** vendor white papers and market-size reports with undisclosed method, 自媒体, forum answers, AI-generated summaries. Use only as leads or labelled opinions. Percent-of-market and "预计将达" figures need the original method.

## Free scholarly sources (searchable through web_search / web_fetch)
arXiv (arxiv.org/abs/…), PubMed/PMC, bioRxiv/medRxiv, Semantic Scholar, OpenAlex, Crossref, Google Scholar, 百度学术, 国家哲学社会科学文献中心, 中国科学院文献情报系统, university repositories, SSRN, DOAJ. 知网/万方/维普 full texts are normally paywalled: read abstract and bibliographic data only.

Fetch APIs directly when helpful (public, no key): `https://api.crossref.org/works?query.bibliographic=<title>&rows=5`, `https://api.openalex.org/works?search=<q>&per-page=10`, `https://export.arxiv.org/api/query?search_query=all:<q>&max_results=10`. Respect rate limits; one request at a time.

## Query patterns
- Exact claim check: `"<exact phrase>" site:gov.cn`; add the year.
- Statistics: `<指标> 2025 统计公报 site:stats.gov.cn`.
- Filings: `<公司> 年度报告 2025 site:cninfo.com.cn`.
- Papers: English keywords + `review OR survey`, then the reference lists; Chinese terms for domestic studies.
- Counter-evidence: search for `<claim> criticism / 争议 / 辟谣 / 撤稿 / retraction`.
- Freshness: check "last updated" and the data year inside the document, not only the page date.

## Red flags
No author or method; numbers without a base; round-number forecasts; circular citation (many pages citing one report); screenshots of charts without data; a "study" on the vendor's own site; DOI that resolves to a different title.
