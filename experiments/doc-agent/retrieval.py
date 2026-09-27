"""Immutable allowlisted document snapshot and bounded lexical retrieval."""
import hashlib, json, re
from dataclasses import dataclass, asdict
from pathlib import Path

CATALOG = (
 ('memory-evidence','docs/implementation/01b-evidence.md','Implemented conversation summaries and source-linked memory evidence'),
 ('iris-evidence','docs/implementation/07-iris-slice-evidence.md','Iris protocol integration checkpoint and its limitations'),
 ('runtime-ownership','docs/adr/0001-chat-runtime-ownership.md','Original chat ownership proposal with later implementation checkpoint'),
 ('architecture-direction','docs/adr/0002-layered-context-and-orchestration.md','Proposed layered context, orchestration and telemetry direction'),
 ('model-catalog','docs/13-model-catalog.md','Model catalog metadata and task-routing design'),
 ('generation-evidence','docs/implementation/02-evidence.md','Generation streaming, cancellation and retry implementation evidence'),
 ('inventory-plan','docs/implementation/03-inventory.md','Planned provider inventory milestone'),
 ('context-memory-spec','docs/implementation/01-context-memory.md','Context memory design and requirements'),
)

@dataclass(frozen=True)
class Source:
    source_id: str
    path: str
    title: str
    revision: str
    content: str

class Corpus:
    def __init__(self,sources):
        self.sources={s.source_id:s for s in sources}
        if len(self.sources)!=len(sources): raise ValueError('Duplicate source identity')
    @classmethod
    def load(cls,root, catalog=CATALOG):
        root=Path(root).resolve(); sources=[]
        for sid,relative,title in catalog:
            p=(root/relative).resolve()
            if not p.is_relative_to(root) or p.suffix!='.md': raise ValueError('Source outside allowed markdown scope')
            if p.stat().st_size>131072: raise ValueError('Source too large: '+relative)
            content=p.read_text(encoding='utf-8')
            sources.append(Source(sid,relative,title,hashlib.sha256(content.encode()).hexdigest(),content))
        return cls(sources)
    def index(self):
        return [{'source_id':s.source_id,'title':s.title,'path':s.path,'lines':len(s.content.splitlines())} for s in self.sources.values()]
    def snapshot(self): return [asdict(s) for s in self.sources.values()]

class Retrieval:
    def __init__(self,corpus,max_calls=8,max_bytes=10000):
        self.corpus=corpus; self.max_calls=max_calls; self.max_bytes=max_bytes
        self.calls=0; self.bytes=0; self.reads=[]
    def execute(self,name,args):
        if self.calls>=self.max_calls: return {'error':'tool_call_limit'}
        self.calls+=1
        if self.bytes>=self.max_bytes: return {'error':'retrieval_byte_limit'}
        try:
            if name=='search_docs': result=self.search(**args)
            elif name=='read_doc': result=self.read(**args)
            else: return {'error':'unknown_tool'}
        except (TypeError,ValueError): return {'error':'invalid_arguments'}
        if name=='read_doc' and 'error' not in result: result['evidence_id']='E'+str(len(self.reads)+1)
        encoded=json.dumps(result,ensure_ascii=False).encode()
        if self.bytes+len(encoded)>self.max_bytes: return {'error':'retrieval_byte_limit','hint':'Request fewer lines.'}
        self.bytes+=len(encoded)
        if name=='read_doc' and 'error' not in result: self.reads.append(result)
        return result
    def search(self,query,limit=3):
        if not isinstance(query,str) or not 1<=len(query.strip())<=160 or type(limit)!=int or not 1<=limit<=3: raise ValueError()
        terms=set(re.findall(r'[a-z0-9_]+',query.lower()))
        stop={'the','is','a','an','and','or','to','of','in','does','what','how','for','with','are'}
        terms-=stop
        if not terms or len(terms)>16: raise ValueError()
        matches=[]
        for s in self.corpus.sources.values():
            hits=[]
            for n,line in enumerate(s.content.splitlines(),1):
                words=set(re.findall(r'[a-z0-9_]+',line.lower())); score=len(terms & words)
                if score: hits.append((score,n,line[:180]))
            if hits:
                hits.sort(key=lambda h:(-h[0],h[1])); best=hits[:2]
                matches.append({'source_id':s.source_id,'revision':s.revision,'score':sum(h[0] for h in best),'hits':[{'line':h[1],'snippet':h[2]} for h in best]})
        matches.sort(key=lambda m:(-m['score'],m['source_id']))
        return {'query':query,'matches':matches[:limit],'scope':'allowlisted snapshot; no hit does not prove absence elsewhere'}
    def read(self,source_id,start_line=1,line_count=30):
        if not isinstance(source_id,str) or source_id not in self.corpus.sources: return {'error':'unknown_source_id'}
        if type(start_line)!=int or type(line_count)!=int or not 1<=line_count<=40 or start_line<1: raise ValueError()
        s=self.corpus.sources[source_id]; lines=s.content.splitlines()
        if start_line>len(lines): return {'error':'line_out_of_range','total_lines':len(lines)}
        chosen=[]; size=0
        for n in range(start_line,min(len(lines)+1,start_line+line_count)):
            line=lines[n-1]
            if size+len(line.encode())>3000: break
            chosen.append({'line':n,'text':line}); size+=len(line.encode())
        if not chosen: return {'error':'line_too_large'}
        end=chosen[-1]['line']
        return {'source_id':s.source_id,'revision':s.revision,'path':s.path,'start_line':start_line,'end_line':end,'total_lines':len(lines),'lines':chosen,'next_line':end+1 if end<len(lines) else None}
