/* Smart Log merchant knowledge: local, deterministic merchant families mapped to
   existing Cap category names. Data only; no DOM, storage, network or writes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CapSmartLogMerchants=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

  /* Each family lists aliases (ordinary merchant spellings) and acceptable
     EXISTING categories from most to least specific. A category is only used
     when it is present in the user's own category list. Ambiguous families are
     never inferred without contextual evidence or reliable local history. */
  const families=[
    // Entertainment / subscriptions
    {id:'spotify',aliases:['spotify premium','spotify'],categories:['Entertainment','Subscriptions']},
    {id:'netflix',aliases:['netflix'],categories:['Entertainment','Subscriptions']},
    {id:'disney',aliases:['disney plus','disney+','disney'],categories:['Entertainment','Subscriptions']},
    {id:'apple-music',aliases:['apple music'],categories:['Entertainment','Subscriptions']},
    {id:'youtube-premium',aliases:['youtube premium'],categories:['Entertainment','Subscriptions']},
    {id:'prime-video',aliases:['prime video'],categories:['Entertainment','Subscriptions']},
    {id:'hbo',aliases:['hbo max','hbo go'],categories:['Entertainment','Subscriptions']},
    {id:'crunchyroll',aliases:['crunchyroll'],categories:['Entertainment','Subscriptions']},
    {id:'viu',aliases:['viu'],categories:['Entertainment','Subscriptions']},

    // Food and dining
    {id:'jollibee',aliases:['jollibee'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'mcdonalds',aliases:['mcdonalds','mcdo'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'kfc',aliases:['kfc'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'chowking',aliases:['chowking'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'mang-inasal',aliases:['mang inasal'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'starbucks',aliases:['starbucks'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'burger-king',aliases:['burger king'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'wendys',aliases:['wendys'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'pizza-hut',aliases:['pizza hut'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'dominos',aliases:['dominos'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'greenwich',aliases:['greenwich'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'red-ribbon',aliases:['red ribbon'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'goldilocks',aliases:['goldilocks'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'bonchon',aliases:['bonchon'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'shakeys',aliases:['shakeys'],categories:['Food','Dining','Dining Out','Restaurants']},
    {id:'foodpanda',aliases:['foodpanda','food panda'],categories:['Food','Dining','Dining Out','Restaurants']},

    // Shopping
    {id:'shopee',aliases:['shopee'],categories:['Shopping']},
    {id:'lazada',aliases:['lazada'],categories:['Shopping']},
    {id:'shein',aliases:['shein'],categories:['Shopping']},
    {id:'temu',aliases:['temu'],categories:['Shopping']},
    {id:'amazon',aliases:['amazon'],categories:['Shopping']},
    {id:'uniqlo',aliases:['uniqlo'],categories:['Shopping']},

    // Transportation
    {id:'angkas',aliases:['angkas'],categories:['Transportation','Transport']},
    {id:'move-it',aliases:['move it'],categories:['Transportation','Transport']},
    {id:'joyride',aliases:['joyride'],categories:['Transportation','Transport']},
    {id:'grab-ride',aliases:['grab ride','grab car','grab taxi'],categories:['Transportation','Transport']},
    {id:'grabfood',aliases:['grabfood','grab food'],categories:['Food','Dining','Dining Out','Restaurants']},

    // Groceries
    {id:'puregold',aliases:['puregold'],categories:['Groceries']},
    {id:'savemore',aliases:['savemore'],categories:['Groceries']},
    {id:'landers',aliases:['landers'],categories:['Groceries']},
    {id:'robinsons-supermarket',aliases:['robinsons supermarket'],categories:['Groceries']},
    {id:'waltermart',aliases:['waltermart'],categories:['Groceries']},

    // Health
    {id:'watsons',aliases:['watsons'],categories:['Health','Healthcare']},
    {id:'mercury-drug',aliases:['mercury drug'],categories:['Health','Healthcare']},
    {id:'southstar-drug',aliases:['southstar drug'],categories:['Health','Healthcare']},
    {id:'generika',aliases:['generika'],categories:['Health','Healthcare']},

    // Ambiguous: require context or reliable history; never guess silently.
    {id:'grab',aliases:['grab'],categories:['Transportation','Transport','Food','Dining','Dining Out','Restaurants'],ambiguous:true,contexts:[
      {pattern:/\b(?:ride|car|taxi|driver|trip|angkas)\b/,categories:['Transportation','Transport']},
      {pattern:/\b(?:food|eats?|delivery|meal|order)\b/,categories:['Food','Dining','Dining Out','Restaurants']}
    ]},
  ];

  function match(title){
    const text=norm(title);if(!text)return null;
    let best=null;
    for(const rule of families)for(const alias of rule.aliases){
      const phrase=norm(alias);if(!phrase||!(' '+text+' ').includes(' '+phrase+' '))continue;
      if(!best||phrase.length>best.alias.length)best={rule,alias:phrase};
    }
    return best;
  }
  function aliasesFor(rule){return [...new Set((rule?.aliases||[]).map(norm).filter(Boolean))]}
  function identity(title){
    const found=match(title);if(!found)return null;
    const rule=found.rule;
    return {id:rule.id,canonical:rule.brand||rule.aliases[0],aliases:aliasesFor(rule),categories:[...rule.categories]};
  }
  function pick(names,available){
    const set=new Set(available);
    for(const name of names){const found=available.find(c=>norm(c)===norm(name));if(set.has(found))return found}
    return null;
  }
  function suggest(found,text,available){
    if(!found)return {state:'none'};
    const rule=found.rule,context=norm(text);
    if(rule.contexts){
      for(const item of rule.contexts)if(item.pattern.test(context)){
        const category=pick(item.categories,available);
        if(category)return {state:'resolved',value:category,candidates:[category],reason:'From a local merchant rule'};
      }
    }
    if(rule.ambiguous){
      const candidates=[...new Set(rule.categories.map(name=>pick([name],available)).filter(Boolean))];
      return {state:'ambiguous',value:null,candidates,reason:'Category needs confirmation: merchant can belong to more than one category'};
    }
    const category=pick(rule.categories,available);
    return category?{state:'resolved',value:category,candidates:[category],reason:'From a local merchant rule'}:{state:'none'};
  }
  return Object.freeze({families:Object.freeze(families.map(r=>Object.freeze({...r,aliases:Object.freeze([...r.aliases]),categories:Object.freeze([...r.categories]),contexts:r.contexts?Object.freeze(r.contexts.map(c=>Object.freeze({...c,categories:Object.freeze([...c.categories])}))):undefined}))),match,aliasesFor,identity,suggest});
});
