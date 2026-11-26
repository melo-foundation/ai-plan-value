import json,csv,re,math,collections,sys
S=sys.argv[1]
d=json.load(open('public/data/combined.json'))
E=d['entries']
F={r['id']:r for r in csv.DictReader(open(S+'/fei/repo/derived/points.csv',encoding='utf-8-sig'))}
q=lambda *a: math.sqrt(sum(x*x for x in a))
FLOOR={'high':0.08,'medium':0.18,'low':0.40}
def fei_sigma(r, depth=0):
    """returns (sigma, chain[])"""
    kind=r['data_date_kind']; conf=r['confidence']; src=r['source']; t=src+' '+r['note']
    chain=[]
    if r['billing']=='metered': return 0.03,[('api-list',0.03)]
    if kind=='official':
        s=0.05 if conf=='high' else 0.12 if conf=='medium' else 0.40
        chain=[('official-table',s)]
    elif kind=='sample':
        tw=bool(re.search(r'X @|推文',src)); shot='截图' in src
        maint=bool(re.search(r'维护者(本机|本地|实测|提供样本)',src)); issue=bool(re.search(r'issue #\d+',src))
        gw=bool(re.search(r'第三方|网关|relay',src))
        if gw or (tw and not issue and not maint): s=0.45; lab='tweet-or-gateway'
        elif shot and not maint and not issue: s=0.35; lab='single-screenshot'
        elif conf=='high': s=0.10; lab='multi-source-sample'
        else: s=0.20; lab='single-account-sample'
        chain=[(lab,s)]
        pps=[float(x) for x in re.findall(r'([\d.]+)\s*pp',t)]
        if pps:
            pp=max(pps[:3]); sr=0.41/pp if pp>0 else 0
            if sr>0.02: chain.append((f'reading-{pp:g}pp',round(sr,3)))
    else: # derived
        anchor=None
        m=re.match(r'由同套餐 (\S+) [\d.]+ 亿 × ([\d.]+)',src)
        if m:
            aid=r['id'].split('::')[0]+'::'+m.group(1)
            anchor=F.get(aid)
            ratio=float(m.group(2))
            if abs(ratio-1)<1e-6: step=('same-pool-same-price',0.15)
            elif re.search(r'fable',r['model']): step=('model-weight-ruled',0.45)
            elif ratio>5 or ratio<0.2: step=('price-ratio-far',0.45)
            else: step=('price-ratio',0.25)
        elif re.search(r'官方',t) and re.search(r'倍率|worth|/20|2倍|Ultra为Max',t): step=('plan-ratio-official',0.25)
        else: step=('plan-ratio-ruled',0.35)
        if anchor is None:
            # find anchor by data_date_from: "Plan · model"
            for x in F.values():
                nm=(x['plan_en'] or x['plan'])
                if r['data_date_from'] and r['data_date_from'].split('、')[0].strip() in (f"{nm} · {x['model']}", f"{x['plan']} · {x['model']}") and x['id']!=r['id']:
                    anchor=x;break
        if anchor is not None and depth<4:
            sa,ca=fei_sigma(anchor,depth+1)
        else:
            sa,ca=FLOOR[conf],[('anchor-unresolved',FLOOR[conf])]
        chain=ca+[step]
    s=q(*[c[1] for c in chain])
    if s<FLOOR[conf]: chain.append((f'source-grade-{conf}',round(math.sqrt(FLOOR[conf]**2-s*s),3))); s=FLOOR[conf]
    return s,chain
def sub_sigma(e):
    o=e['origin']
    if e['billing']=='metered' or o in('github-copilot','kilo-pass','ollama-cloud','artificial-analysis'): return 0.03,[('official-credits',0.03)]
    if o=='fei2411':
        r=F.get(e['id'].split('@')[0])
        if r: return fei_sigma(r)
        return FLOOR[e['confidence']],[('fei-unmatched',FLOOR[e['confidence']])]
    if o=='priors-repo':
        s={'high':0.10,'medium':0.22,'low':0.45}[e['confidence']]; return s,[('priors-mirror-'+e['confidence'],s)]
    if o=='priors-preliminary':
        lab=(e.get('preliminary') or {}).get('label','')
        if 'Extrapolated' in lab: return q(0.40,0.25),[('prelim-1-user',0.40),('plan-ratio-official',0.25)]
        if 'Promotion' in lab: return 0.05,[('official-promo',0.05)]
        n=int((re.search(r'(\d+) user',lab) or [0,1])[1])
        s=0.40/math.sqrt(n) if n>1 else 0.40
        return s,[(f'prelim-{n}-user',round(s,3))]
    if o=='priors-assumed': return q(0.22,0.70),[('anchor',0.22),('cross-model-assumed',0.70)]
    if o=='shared-pool-assumed': return q(0.30,0.70),[('anchor',0.30),('cross-model-assumed',0.70)]
    return 0.5,[('unknown',0.5)]
def cost_sigma(e):
    if not e.get('effortEstimate'): return 0.05,[('aa-measured',0.05)]
    if e['effortEstimate']=='interpolated': return 0.17,[('effort-interp',0.17)]
    if e.get('effortEstimateSource')=='arc-agi-2': return 0.40,[('effort-arc',0.40)]
    n=e.get('effortEstimateSteps') or 9
    s={1:0.21,2:0.37,3:0.52}.get(n,0.70); return s,[(f'effort-{n}-step',s)]
def level(s): return 'A' if s<=0.22 else 'B' if s<=0.45 else 'C' if s<=0.80 else 'D'
if __name__=='__main__':
    cnt=collections.Counter(); cs=collections.Counter(); cross=collections.Counter()
    base=collections.Counter(); seen=set(); ex=[]
    old=lambda e: (e['confidence'], e.get('estimateConfidence'))
    for e in E:
        ss,sc=sub_sigma(e); cc,ccn=cost_sigma(e); tot=q(ss,cc)
        e['_s']=ss; e['_c']=cc; e['_t']=tot; e['_chain']=sc+ccn
        cnt[level(tot)]+=1; cs[level(ss)]+=1
        cross[(e['confidence'],level(ss))]+=1
        k=(e['plan'],e['baseModelId'])
        if k not in seen: seen.add(k); base[(e['origin'],level(ss))]+=1
    print('total level (subsidy+cost, mode=task):',dict(sorted(cnt.items())))
    print('subsidy-only level:',dict(sorted(cs.items())))
    print('old subsidy confidence x new subsidy level:'); 
    for k,v in sorted(cross.items()): print('  ',k,v)
    # current default visibility: estTier high or none -> shown
    shown=[e for e in E if e.get('estimateConfidence') in (None,'high')]
    print('currently shown by default:',len(shown),'-> new levels',dict(sorted(collections.Counter(level(e['_t']) for e in shown).items())))
    print('new default (A+B+C):',sum(1 for e in E if level(e['_t'])!='D'),' (A+B):',sum(1 for e in E if level(e['_t']) in 'AB'))
    print('base rows origin x level');
    for k,v in sorted(base.items()): print('  ',k,v)
    want=[('Claude Pro','claude-opus-5-5--max'),('Claude Pro','claude-fable-5-2--max'),('Claude Max','claude-fable-5-2--max'),('Claude Ultra','claude-fable-5-2--max'),('Claude Max','claude-opus-5--max'),('Claude Max','claude-opus-5--high'),('Claude Max','claude-fable-5-1--max'),('Claude Pro','claude-haiku-5-5--max'),('Google AI Ultra 20x','gemini-4-argon--high'),('Google AI Pro','gemini-4-argon--high'),('Google AI Ultra 5x','gemini-4-neon--xhigh'),('Google AI Pro','gemini-4-carbon--high'),('Kimi Max','kimi-k3-1-pro--max'),('Kimi Max','kimi-k3--max'),('Claude Team Premium','claude-opus-5-5--max'),('ChatGPT Plus','gpt-6-1-sol--max'),('ChatGPT Pro 20x','gpt-6-2-astra--max'),('Claude Max','claude-opus-5-5--max'),('Claude Ultra','claude-opus-5-5--max')]
    for p,m in want:
        for e in E:
            if e['plan']==p and e['modelId']==m:
                rc=e['aaCostPerTaskUsd']/e['subsidyMultiple']; t=e['_t']
                print(f"{p:<20}{m:<26} S={e['subsidyMultiple']:<8} old={e['confidence'][:3]}/{str(e.get('estimateConfidence'))[:4]:<4} σS={e['_s']:.2f} σC={e['_c']:.2f} σ={t:.2f} {level(t)}  real=${rc:.3f} 80%: ${rc*math.exp(-1.28*t):.3f}–${rc*math.exp(1.28*t):.3f}  chain={[(a,round(b,2)) for a,b in e['_chain']]}")
                break
        else: print('missing',p,m)
