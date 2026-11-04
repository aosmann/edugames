/* EduGames portal: Romanian / English. The page is written in English; when Romanian is on, every text and
   label the page shows is swapped for its Romanian version as it appears (a MutationObserver), and back again
   when English is picked. EDU_I18N.lang is 'ro' or 'en'; EDU_I18N.set(lang) switches live; T(text) translates
   a string for alerts, file names and exports. */
(function(){
const KEY='edu-lang';
let lang;try{lang=localStorage.getItem(KEY)}catch(e){}
if(lang!=='ro'&&lang!=='en')lang=/^ro\b/i.test(navigator.language||'')?'ro':'en';

/* bank: subjects, topics, levels, continents (shared with the games) */
const BANK={
 'English':'Engleză','Grammar, words and spelling':'Gramatică, vocabular și ortografie',
 'Irregular verbs':'Verbe neregulate','Opposites':'Antonime','Tenses':'Timpuri verbale','Prepositions':'Prepoziții','Spelling':'Ortografie','Phrasal verbs':'Verbe frazale',
 'Math':'Matematică','Mental arithmetic, fast':'Calcul mintal, rapid','Quick sums':'Adunări rapide','add and subtract up to 20':'adunări și scăderi până la 20',
 'Two digits':'Numere de două cifre','Times tables':'Tabla înmulțirii','2× up to 12×':'de la 2× la 12×','Division':'Împărțire','tables in reverse':'tabla, invers',
 'Percentages':'Procente','10%, 25%, 75% of a number':'10%, 25%, 75% dintr-un număr','Negative numbers':'Numere negative','below zero and back':'sub zero și înapoi',
 'Squares and roots':'Pătrate și radicali','Order of operations':'Ordinea operațiilor','multiply before you add':'înmulțirea înaintea adunării',
 'Geography':'Geografie','Countries, capitals and flags':'Țări, capitale și steaguri','Capitals':'Capitale','Guess the flag':'Ghicește steagul','pick the continents':'alege continentele',
 'Science':'Științe','Space, chemistry and the body':'Spațiu, chimie și corpul uman','Planets':'Planete','our solar system':'sistemul nostru solar',
 'Human body':'Corpul uman','organs, bones and blood':'organe, oase și sânge','Chemical symbols':'Simboluri chimice','Fe, Au, Na and friends':'Fe, Au, Na și prietenii',
 'Informatics':'Informatică','Binary, code and computers':'Binar, cod și calculatoare','Keyboard shortcuts':'Scurtături de tastatură','Ctrl + the right key':'Ctrl + tasta potrivită',
 'Data units':'Unități de date','bits, bytes and hex':'biți, octeți și hexazecimal','Binary numbers':'Numere binare','4-bit, both directions':'pe 4 biți, în ambele sensuri',
 'Python operators':'Operatori Python','Mix it up':'Amestec','Questions from every subject':'Întrebări din toate materiile','Easy mix':'Amestec ușor','every easy topic':'toate temele ușoare',
 'Surprise me':'Surprinde-mă','any topic, any subject':'orice temă, orice materie','Hard mix':'Amestec greu','only the toughest topics':'doar temele cele mai grele',
 'went, gone, taught, written':'went, gone, taught, written','hot and cold, win and lose':'hot și cold, win și lose','present, past, perfect, continuous':'prezent, trecut, perfect, continuu',
 'good at, afraid of, wait for':'good at, afraid of, wait for','the words everyone gets wrong':'cuvintele pe care le greșește toată lumea','give up, look into, call off':'give up, look into, call off',
 'Check it! A2 · routines, free time, town':'Check it! A2 · rutina zilnică, timp liber, orașul','Check it! B2+ · modals, cars and the road, take/make/do':'Check it! B2+ · verbe modale, mașini și drumuri, take/make/do',
 'Easy':'Ușor','Medium':'Mediu','Hard':'Greu','Europe':'Europa','Asia':'Asia','Africa':'Africa','Americas':'Americi','Oceania':'Oceania','All continents':'Toate continentele','All':'Toate',
 'Topics':'Teme','Units':'Unități','Continents':'Continente'};

/* the portal */
const UI={
 'Learn it by playing it.':'Înveți jucându-te.','Every game works with every subject. Play on your own, or bring the whole class in.':'Fiecare joc merge cu fiecare materie. Joacă singur sau adu toată clasa.',
 'Play':'Joacă','Class':'Clasă','Reports':'Rapoarte','Join':'Intră','Home':'Acasă','Games':'Jocuri','Play together in class':'Jucați împreună în clasă',
 'Show a QR code on the board. Students join with a name and a cat, and you choose the game.':'Arată un cod QR pe tablă. Elevii intră cu un nume și o pisică, iar tu alegi jocul.',
 'Start a class':'Începe o oră','+ your class':'+ clasa ta','Loading games…':'Se încarcă jocurile…','All games':'Toate jocurile','Back to class':'Înapoi la clasă','Change game':'Schimbă jocul',
 'Subject':'Materie','Topic':'Temă','Choose a subject':'Alege o materie','Choose a subject first':'Alege întâi o materie','Choose a topic':'Alege o temă','Choose a unit':'Alege o unitate',
 'Pick a subject and topic':'Alege materia și tema','Now pick a topic':'Acum alege o temă','Choose a topic to play':'Alege o temă ca să joci','Choose a topic to start':'Alege o temă ca să începi',
 'Your results are saved on this device and show up in Reports.':'Rezultatele se salvează pe acest dispozitiv și apar la Rapoarte.',
 'Anyone who joins later gets this round too.':'Cine intră mai târziu primește și el această rundă.',
 'Nobody has joined yet. You can still start; students who join later get this round.':'Încă n-a intrat nimeni. Poți porni oricum; cine intră mai târziu primește runda.',
 'Difficulty':'Dificultate','Clock':'Ceas','Time':'Timp','Custom':'Personalizat','Quick':'Rapid','Normal':'Normal','Relaxed':'Relaxat','Start':'Start','Right answer':'Răspuns corect','Wrong answer':'Răspuns greșit',
 'Race length':'Lungimea cursei','Laps':'Ture','Track':'Pistă','Sunny Meadow':'Pajiștea însorită','Canyon Run':'Canionul','Frosty Peaks':'Vârfurile înghețate','Beach Bay':'Golful cu plajă',
 'Run length':'Durata','Play for':'Joacă','Shots':'Lovituri','Seconds':'Secunde',
 'Couldn\'t load this game\'s topics. Check the connection.':'Nu s-au putut încărca temele jocului. Verifică conexiunea.','Loading…':'Se încarcă…',
 'Join at':'Intră pe','Class code':'Codul clasei','Opening…':'Se deschide…','Opening the class…':'Se deschide clasa…','No connection':'Fără conexiune','End class':'Încheie ora',
 'Who can join':'Cine poate intra','Anyone':'Oricine','students type their name':'elevii își scriu numele','Allow guests':'Permite invitați','Reload class lists':'Reîncarcă listele claselor',
 'Use a class list':'Folosește o listă de clasă','Load classes':'Încarcă clasele','Wrong PIN':'PIN greșit','Loading class lists…':'Se încarcă listele claselor…',
 'Couldn\'t load the class lists. Check the connection.':'Nu s-au putut încărca listele claselor. Verifică conexiunea.',
 'Waiting for students to join…':'Așteptăm să intre elevii…','Pick a game':'Alege un joc','students':'elevi','student':'elev',
 'Choose the topic and settings, then start it on every student\'s device at once.':'Alege tema și setările, apoi pornește jocul pe dispozitivele tuturor elevilor deodată.',
 'Connection lost. Reconnecting… students stay in the class.':'Conexiunea s-a pierdut. Se reconectează… elevii rămân în clasă.',
 'Connecting through the backup class server… it can take up to a minute to wake up.':'Ne conectăm prin serverul de rezervă… poate dura până la un minut să pornească.',
 'Tap anywhere to close':'Atinge oriunde ca să închizi',
 'End round':'Încheie runda','playing':'joacă','finished':'au terminat','starting…':'pornește…','Start race':'Pornește cursa','Open track on projector':'Arată pista pe proiector',
 'Students wait on the grid until you start.':'Elevii așteaptă la start până pornești tu.','Race on! Late joiners start from the grid.':'Cursa a început! Cine intră acum pornește de la start.',
 'Round over':'Runda s-a terminat','Play again':'Mai joacă o dată','Pick another game':'Alege alt joc','End class and see report':'Încheie ora și vezi raportul',
 'Results stay on this device. Filter by game, day, session or student, then export.':'Rezultatele rămân pe acest dispozitiv. Filtrează după joc, zi, oră sau elev, apoi exportă.',
 'Game':'Joc','Session':'Ora','From':'De la','To':'Până la','Student':'Elev','Any name':'Orice nume','Include my own games':'Include jocurile mele','All classes':'Toate clasele','All sessions':'Toate orele',
 'My own games':'Jocurile mele','Export Excel':'Exportă Excel','Export CSV':'Exportă CSV','Preparing…':'Se pregătește…','Date':'Data','Level':'Nivel','Score':'Scor','Right':'Corecte','Best streak':'Cea mai lungă serie',
 'results':'rezultate','average right':'media răspunsurilor corecte','No results match these filters.':'Niciun rezultat pentru aceste filtre.',
 'No class results yet. Run a class and the results show up here.':'Încă nu există rezultate. Ține o oră și rezultatele apar aici.',
 'Most missed questions':'Cele mai greșite întrebări','The questions most students got wrong, with the wrong answer they picked most':'Întrebările greșite de cei mai mulți elevi și răspunsul greșit ales cel mai des',
 'Right:':'Corect:','· Most picked:':'· Ales cel mai des:','Most picked:':'Ales cel mai des:','No wrong answers here. Nice work, class.':'Niciun răspuns greșit. Bravo, clasă!',
 'Skills':'Abilități','Share of right answers, weakest first':'Procentul de răspunsuri corecte, de la cel mai slab','Students who may need help':'Elevi care ar putea avea nevoie de ajutor',
 'Lowest share of right answers, with their weakest area':'Cel mai mic procent de răspunsuri corecte și partea cea mai slabă',
 'Skill and student breakdowns appear for class rounds played with the latest game versions.':'Analiza pe abilități și pe elevi apare pentru rundele jucate cu versiunile noi ale jocurilor.',
 'Join a class':'Intră în clasă','Your teacher shows the code on the board.':'Profesorul îți arată codul pe tablă.','Tap to change':'Atinge ca să schimbi','Your name':'Numele tău','First name':'Prenume',
 'Next':'Mai departe','Connecting…':'Se conectează…','Joining…':'Intri…','Back to games':'Înapoi la jocuri','Choose your name':'Alege-ți numele',
 'I\'m not on the list · join as a guest':'Nu sunt pe listă · intru ca invitat','Back to the class list':'Înapoi la lista clasei','Choose your name from the list.':'Alege-ți numele din listă.',
 'Type your name so your teacher knows who you are.':'Scrie-ți numele ca să știe profesorul cine ești.','Pick your name from the list.':'Alege-ți numele din listă.',
 'Guests can\'t join this class. Pick your name from the list.':'Invitații nu pot intra în această clasă. Alege-ți numele din listă.',
 'Your name isn\'t on the class list. Pick it below.':'Numele tău nu e pe listă. Alege-l mai jos.',
 'The class code has 5 characters.':'Codul clasei are 5 caractere.','Can\'t reach the class. Check the internet connection and try again.':'Nu ne putem conecta la clasă. Verifică internetul și încearcă din nou.',
 'Waiting for your teacher to start the game.':'Așteaptă ca profesorul să pornească jocul.','You\'re in':'Ai intrat','Your teacher is picking the next game. Keep this page open.':'Profesorul alege următorul joc. Lasă pagina deschisă.',
 'Class finished':'Ora s-a încheiat','Thanks for playing. You can close this page.':'Mulțumim că ai jucat! Poți închide pagina.','Reconnecting…':'Se reconectează…',
 'Your teacher\'s screen lost its connection. Waiting for it to come back…':'Ecranul profesorului a pierdut conexiunea. Așteptăm să revină…',
 'You were removed from the class':'Ai fost scos din clasă','Ask your teacher if this was a mistake, then scan the code again.':'Întreabă profesorul dacă a fost o greșeală, apoi scanează din nou codul.',
 'Pick your avatar':'Alege-ți avatarul','Done':'Gata','Surprise me: pick a random avatar':'Surprinde-mă: alege un avatar la întâmplare',
 'Party cat':'Pisica de petrecere','Sleepy cat':'Pisica somnoroasă','Sassy cat':'Pisica obraznică','Cheeky cat':'Pisica șmecheră','Strawberry cat':'Pisica-căpșună','Angry cat':'Pisica supărată',
 'Hungry cat':'Pisica flămândă','Cool cat':'Pisica cool','Fancy cat':'Pisica elegantă','Artist cat':'Pisica artistă','Cosy cat':'Pisica pufoasă','Movie star cat':'Pisica vedetă','DJ cat':'Pisica DJ',
 'Change your avatar':'Schimbă-ți avatarul','Avatars':'Avatare','Teacher PIN':'PIN profesor','Show the QR code larger':'Arată codul QR mai mare','QR code to join the class':'Cod QR pentru a intra în clasă',
 'How to join':'Cum intri','Class code: late joiners can still use it':'Codul clasei: îl pot folosi și cei care intră mai târziu','Leaderboard':'Clasament','Race track':'Pistă','Race track, live':'Pista, în direct',
 'Topics or units':'Teme sau unități','Subjects':'Materii','EduGames home':'Pagina principală EduGames','Mode':'Mod','Round':'Runda',
 'Answer right. Build to the sky.':'Răspunde corect. Construiește până la cer.','Slice the right answer. Dodge the bombs.':'Taie răspunsul corect. Ferește-te de bombe.',
 'Flick it in. Nothing but the right answer.':'Aruncă la coș. Doar răspunsul corect.','Answer fast. Every right answer drops a block perfectly.':'Răspunde repede. Fiecare răspuns corect așază piesa perfect.',
 'Answer right. Boost ahead.':'Răspunde corect. Accelerează.','Read it. Aim it. Score.':'Citește. Țintește. Marchează.','Run the lanes. Answer on the move.':'Aleargă pe culoare. Răspunde din mers.',
 'End the class? Every student will be disconnected.':'Închei ora? Toți elevii vor fi deconectați.','Couldn\'t prepare the Excel file. Check the connection, or export CSV instead.':'Nu s-a putut pregăti fișierul Excel. Verifică conexiunea sau exportă CSV.',
 'No classes found in that file.':'Nu s-au găsit clase în fișier.','Couldn\'t open the class':'Nu s-a putut deschide clasa','Language':'Limba',
 /* exports */
 'Session code':'Cod oră','Subject name':'Materie','Asked':'Întrebări','% right':'% corecte','Missed questions':'Întrebări greșite','Question':'Întrebare','They picked':'A ales','Common mistakes':'Greșeli frecvente',
 'Skill':'Abilitate','Wrong':'Greșite','Answered':'Răspunsuri','% wrong':'% greșite','Most picked wrong':'Greșeala cea mai aleasă','Students':'Elevi','All answers':'Toate răspunsurile','Correct':'Corect','yes':'da','no':'nu',
 'Results':'Rezultate','Topic name':'Temă',
 'Results are saved on this device and online for every teacher. Filter by game, day, session or student, then export.':'Rezultatele se salvează pe acest dispozitiv și online pentru toți profesorii. Filtrează după joc, zi, oră sau elev, apoi exportă.',
 'Results are only on this device. Enter the teacher PIN to see the school\'s reports and save yours online.':'Rezultatele sunt doar pe acest dispozitiv. Introdu PIN-ul de profesor ca să vezi rapoartele școlii și să le salvezi online pe ale tale.',
 'Show the school\'s reports':'Arată rapoartele școlii',
 'The teacher PIN changed. Enter it again in the class room to keep saving results online.':'PIN-ul de profesor s-a schimbat. Introdu-l din nou ca rezultatele să se salveze online.',
 'Couldn\'t reach the class server. Showing what is saved on this device.':'Nu ne putem conecta la serverul clasei. Arătăm ce e salvat pe acest dispozitiv.','Saved online for every teacher':'Salvat online pentru toți profesorii'};
const D=Object.assign({},BANK,UI);
const P=[ /* patterns: numbers and names inside sentences */
 [/^(\d+) topics$/,(m)=>`${m[1]} teme`],[/^(\d+) topics · (\d+) units?$/,m=>`${m[1]} teme · ${m[2]} ${m[2]==='1'?'unitate':'unități'}`],[/^(\d+) subjects$/,m=>`${m[1]} materii`],
 [/^(\d+) students?$/,m=>`${m[1]} ${m[1]==='1'?'elev':'elevi'}`],[/^(\d+) students? ready$/,m=>`${m[1]} ${m[1]==='1'?'elev pregătit':'elevi pregătiți'}`],
 [/^(\d+) students pick their name$/,m=>`${m[1]} elevi își aleg numele`],[/^(\d+) results?$/,m=>`${m[1]} ${m[1]==='1'?'rezultat':'rezultate'}`],
 [/^(\d+) of (\d+) right$/,m=>`${m[1]} din ${m[2]} corecte`],[/^(\d+) of (\d+) wrong$/,m=>`${m[1]} din ${m[2]} greșite`],[/^(\d+)\/(\d+) right$/,m=>`${m[1]}/${m[2]} corecte`],
 [/^Start for everyone \((\d+)\)$/,m=>`Pornește pentru toți (${m[1]})`],[/^Start for everyone$/,()=>'Pornește pentru toți'],[/^Play · (.+)$/,m=>`Joacă · ${tr(m[1])||m[1]}`],
 [/^(.+) wins!$/,m=>`Câștigă ${m[1]}!`],[/^You came (\d+)\w\w of (\d+)$/,m=>`Ai ieșit pe locul ${m[1]} din ${m[2]}`],[/^You're in, (.+)$/,m=>`Ai intrat, ${m[1]}`],
 [/^Class (.+)$/,m=>`Clasa ${m[1]}`],[/^(.+) · not here yet \((\d+)\): (.+)$/,m=>`${m[1]} · lipsesc încă (${m[2]}): ${m[3]}`],[/^(.+) · everyone is here$/,m=>`${m[1]} · toți sunt aici`],
 [/^(.+) · already in$/,m=>`${m[1]} · a intrat deja`],[/^(.+) is already in the class\. Pick your own name\.$/,m=>`${m[1]} a intrat deja. Alege-ți propriul nume.`],
 [/^(.+) is on the class list\. Pick it from the list instead\.$/,m=>`${m[1]} e pe lista clasei. Alege-l din listă.`],
 [/^No open class with code (\w+)\. Check the code on the board\.$/,m=>`Nu există o clasă deschisă cu codul ${m[1]}. Verifică codul de pe tablă.`],
 [/^Remove (.+) from the class\?$/,m=>`Scoți pe ${m[1]} din clasă?`],[/^Remove (.+) from the class$/,m=>`Scoate pe ${m[1]} din clasă`],[/^Remove (.+)$/,m=>`Scoate pe ${m[1]}`],
 [/^Your avatar: (.+)\. Tap to change$/,m=>`Avatarul tău: ${tr(m[1])||m[1]}. Atinge ca să schimbi`],
 [/^(\d+) rounds? played\. Pick the next game; everyone in the class gets it automatically\.$/,m=>`${m[1]} ${m[1]==='1'?'rundă jucată':'runde jucate'}. Alege următorul joc; toată clasa îl primește automat.`],
 [/^(.+) · (\d+) results? saved$/,m=>`${tr(m[1])||m[1]} · ${m[2]} ${m[2]==='1'?'rezultat salvat':'rezultate salvate'}`],
 [/^(\d+) laps$/,m=>`${m[1]} ture`],[/^(\d+) penalties$/,m=>`${m[1]} lovituri`],[/^(\d+) shots$/,m=>`${m[1]} lovituri`],[/^(.+) \(guest\)$/,m=>`${m[1]} (invitat)`],
 [/^Which flag\? (.+)$/,m=>`Ce steag? ${m[1]}`],[/^Difficulty: (.+)$/,m=>`Dificultate: ${tr(m[1])||m[1]}`],[/^(Less|More) (.+)$/,m=>`${m[1]==='Less'?'Mai puțin':'Mai mult'}: ${(tr(m[2].replace(/^./,c=>c.toUpperCase()))||m[2]).toLowerCase()}`],
 [/^weakest: (.+) \((\d+)%\)$/,m=>`cel mai slab: ${tr(m[1])||m[1]} (${m[2]}%)`],[/^(\d+) of (\d+) right · weakest: (.+) \((\d+)%\)$/,m=>`${m[1]} din ${m[2]} corecte · cel mai slab: ${tr(m[3])||m[3]} (${m[4]}%)`],
 [/^(\d+) round$/,m=>`${m[1]} rundă`],
 [/^Saved online for every teacher · updated (.+)$/,m=>`Salvat online pentru toți profesorii · actualizat ${m[1]}`],
 [/^(\d+) sessions? not saved online yet\. They will be sent when the class server can be reached\.$/,m=>`${m[1]} ${m[1]==='1'?'oră nu e salvată':'ore nu sunt salvate'} online încă. Se trimit când serverul clasei e disponibil.`],
 [/^Couldn't reach the class server\. (.+)$/,()=>'Nu ne putem conecta la serverul clasei. Verifică dacă dispozitivul are internet. Dacă alte site-uri merg, rețeaua îl blochează: roagă IT-ul școlii să permită accesul.'],
 [/^(A2|B1|B2|B2\+|C1) · Unit (\d+)$/,m=>`${m[1]} · Unitatea ${m[2]}`],[/^Unit (\d+)$/,m=>`Unitatea ${m[1]}`],
 [/^(.+?) · (.+)$/,m=>{const parts=m[0].split(' · ');let hit=false;const out=parts.map(x=>{const r=tr(x);if(r!=null&&r!==x){hit=true;return r}return x});return hit?out.join(' · '):null}]];
function tr(t){if(D[t]!=null)return D[t];for(const [re,f] of P){const m=re.exec(t);if(m){const r=f(m);if(r!=null)return r}}return null}
function T(t){return lang==='ro'?(tr(t)??t):t}

/* swap text nodes and labels as they appear; remember the English so switching back works */
const orig=new WeakMap(),ATTR=['placeholder','aria-label','title'];
function doText(n){if(n.parentElement&&n.parentElement.closest('script,style,svg,textarea,[data-noi18n]'))return;
  const rec=orig.get(n);if(rec&&n.nodeValue===rec.shown){if(lang==='en'&&rec.shown!==rec.en){n.nodeValue=rec.en;rec.shown=rec.en}else if(lang==='ro'){const r=tr(rec.en.trim());const s=r!=null?rec.en.replace(rec.en.trim(),r):rec.en;if(s!==rec.shown){n.nodeValue=s;rec.shown=s}}return}
  const en=n.nodeValue,k=en.trim();if(!k||!/[A-Za-z]/.test(k)){orig.delete(n);return}
  let shown=en;if(lang==='ro'){const r=tr(k);if(r!=null)shown=en.replace(k,r)}
  orig.set(n,{en,shown});if(shown!==en)n.nodeValue=shown}
function doAttr(e){if(e.closest('svg,[data-noi18n]'))return;let r=orig.get(e);if(!r){r={};orig.set(e,r)}
  for(const a of ATTR){const v=e.getAttribute(a);if(v==null)continue;const rec=r[a];
    let en=rec&&v===rec.shown?rec.en:v;const want=lang==='ro'?(tr(en)??en):en;r[a]={en,shown:want};if(want!==v)e.setAttribute(a,want)}}
function walk(root){if(!root)return;if(root.nodeType===3)return doText(root);if(root.nodeType!==1)return;
  if(ATTR.some(a=>root.hasAttribute(a)))doAttr(root);
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);let n;
  while(n=w.nextNode()){if(n.nodeType===3)doText(n);else if(ATTR.some(a=>n.hasAttribute(a)))doAttr(n)}}
let busy=false;
const mo=new MutationObserver(list=>{if(busy)return;busy=true;try{for(const m of list){
  if(m.type==='characterData')doText(m.target);else if(m.type==='attributes')doAttr(m.target);else m.addedNodes.forEach(walk)}}finally{busy=false}});
function start(){walk(document.body);mo.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:ATTR});document.documentElement.lang=lang}
if(document.body)start();else document.addEventListener('DOMContentLoaded',start);
const subs=[];
window.EDU_I18N={get lang(){return lang},tr,T,
  set(l){if(l!=='ro'&&l!=='en'||l===lang)return;lang=l;try{localStorage.setItem(KEY,l)}catch(e){}document.documentElement.lang=l;busy=true;try{walk(document.body)}finally{busy=false}subs.forEach(f=>{try{f(l)}catch(e){}})},
  onChange(f){subs.push(f)}};
window.T=T;
})();
