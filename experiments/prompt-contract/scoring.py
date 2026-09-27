"""Scoring contract frozen before live v2 execution."""
import json, re
VERSION='contract-score/1'
PREFIX=r'^(?:Model|Task|Document|Result|Attempt|Change|Claim|Job|Source|Test) ([A-Z][0-9]*)$'

def unique_object(pairs):
    obj={}
    for key,value in pairs:
        if key in obj: raise ValueError('Duplicate JSON key')
        obj[key]=value
    return obj

def score(response, expected):
    content=response.get('message',{}).get('content','')
    valid_end=response.get('done') is True and response.get('done_reason')=='stop'
    strict=True
    try: obj=json.loads(content,object_pairs_hook=unique_object)
    except (ValueError,TypeError):
        strict=False
        m=re.fullmatch(r'\s*```(?:json)?\s*(.*?)\s*```\s*',content,re.S) if isinstance(content,str) else None
        try: obj=json.loads(m[1],object_pairs_hook=unique_object) if m else None
        except ValueError: obj=None
    shape=isinstance(obj,dict) and set(obj)=={'answer'} and isinstance(obj['answer'],list) and all(isinstance(x,str) for x in obj['answer'])
    exact=bool(shape and sorted(obj['answer'])==sorted(expected))
    normalized=[re.sub(PREFIX,r'\1',s) for s in obj['answer']] if shape else None
    return {'content_correct':bool(valid_end and shape and sorted(normalized)==sorted(expected)),
            'exact_pass':bool(valid_end and strict and exact),
            'strict_format':bool(valid_end and strict and shape),
            'complete':valid_end,'parsed':obj,'scoring_version':VERSION}
