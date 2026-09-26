import type { Tier, WordPackId } from '../types';

/** Splits a whitespace-separated block of words into a list. */
const words = (block: string): readonly string[] => block.trim().split(/\s+/);

/** Curated word packs (spec §3.10); tier = word length: easy 3–5, medium 6–9, hard 10–14. */
export const PACKS: Record<'tennis' | 'everyday', Record<Tier, readonly string[]>> = {
  tennis: {
    easy: words(`
      ace ball net lob set love game spin serve let fault deuce court line clay grass slice smash drop
      shot rally match point score grip swing chip drive flat kick hit toss win tie break hold out fast
      pace arc alley deep wide body cross angle touch flick block split step lunge reach chase dash run
      jump leap dive slide spot aim cup medal prize title champ crowd fans cheer clap judge call chair
      towel shoe socks band cap visor kit bag gut frame head tape pro star seed draw round final tour
      open slam lead bagel cut dip cord post bye mixed pair team duo coach drill rest sun wind lawn turf
      chalk rival foe duel bout side half zone gap pass push chop carve loop whip punch feed skid clip
      edge power speed tempo focus nerve grit poise calm upset rank elite lefty glory debut
      dojo kata bow belt obi kiai dan kyu mat judo budo zen ninja palm elbow knee heel foot hand throw
      roll fall flip sweep spar form honor black white brown green blue sumo kendo wushu ronin gong drum
      lotus crane tiger snake eagle horse chi yin yang sash guard dodge weave jab hook twist pivot pin
      lock flow mind path way art skill kneel parry feint jog gym agile swift quick sharp tough bold
      brave grace flair style gold pupil boxer glove combo
    `),
    medium: words(`
      backhand forehand baseline volley topspin tiebreak racquet dropshot umpire overhead sweetspot
      racket bounce receiver server service return advantage backspin underspin sidespin footwork
      linesman moonball overrule referee replay doubles singles stroke strings overgrip headband
      wristband sneakers tracksuit backcourt forecourt footfault ranking seeding qualifier finalist
      semifinal tourney champion trophy stadium clubhouse practice training warmup cooldown stretch
      stamina fitness agility balance rhythm timing tactics strategy momentum comeback rivalry opponent
      partner spectator audience applause baseliner grandslam hardcourt walkover wildcard challenge
      hindrance underhand overhand backswing backboard linejudge gamepoint setpoint kickserve approach
      sideline southpaw marathon victory victor defeat winner bracket scoreline stringbed dampener
      grommet ballkid scorer announcer ovation podium legend veteran rookie prodigy rematch showdown
      amateur unseeded contender underdog tweener indoor outdoor silver bronze
      sensei blackbelt karate aikido taekwondo jujitsu kumite randori samurai bushido tatami hakama
      master student respect courage patience strength breathing stance uppercut sidekick strike
      counter defense sparring grapple takedown ceremony dragon mantis monkey leopard phoenix scroll
      lantern bamboo kimono judoka kickboxer breakfall backflip handstand cartwheel footsweep cranekick
      jumprope reflex quickness warrior promotion etiquette willpower gratitude humility harmony
      serenity stillness wisdom loyalty integrity spirit energy mentor lesson grading stripe yellow
      orange purple technique movement posture position distance precision accuracy control velocity
      reaction instinct endurance flexible salute temple pagoda headgear shinguard uniform wrestler
      hapkido capoeira boxing wrestling
    `),
    hard: words(`
      counterpuncher championship breakpoint doublefault passingshot groundstroke tournament
      serveandvolley crosscourt halfvolley matchpoint changeover grandstand scoreboard quarterfinal
      semifinalist tiebreaker dropvolley breadstick doublebagel scorekeeper timekeeper groundskeeper
      chairumpire topspinlob approachshot unforcederror forcederror followthrough deucecourt
      overheadsmash mixeddoubles tennisball tenniscourt tenniselbow tennisracket serviceline servicebox
      centerline centermark doublesalley codeviolation timeviolation luckyloser qualifying secondserve
      firstserve servicegame servicebreak chipandcharge commentator sportsmanship competition
      competitor athleticism concentration determination anticipation coordination consistency
      flexibility persistence perseverance confidence exhibition invitational professional titleholder
      challenger frontrunner powerhouse shotmaking percentageplay matchtiebreak
      grandmaster discipline meditation roundhouse kickboxing somersault stretching shadowboxing
      martialartist breathwork mindfulness tranquility respectful politeness dedication commitment
      resilience enlightenment apprentice instructor demonstration karatechop flyingkick crescentkick
      palmstrike counterattack groundwork shoulderthrow horsestance boardbreaking conditioning
      reactiontime combination mouthguard masterclass agilityladder medicineball punchingbag
    `),
  },
  everyday: {
    easy: words(`
      cat dog sun moon tree book cake milk bread apple house water chair table happy smile cloud rain
      snow wind star fish bird frog duck horse mouse lemon grape peach plum pear corn rice soup salt
      sugar honey jam tea cup plate spoon fork bowl pan oven sink door wall roof floor room bed lamp
      desk pen ink paper note card map road car bus train boat ship plane bike park city town farm
      field hill lake river ocean beach sand shell wave rock stone leaf root grass rose tulip daisy
      lily bee ant owl bear wolf fox deer goat sheep cow pig hen lamb zebra tiger lion whale crab seal
      swan kite doll toy drum bell song music piano flute harp radio phone clock watch hour day week
      month year red blue green pink gold gray brown white black one two three four five six seven
      eight nine ten kind brave calm quiet loud soft warm cold hot cool fresh clean sweet sour salty
      dark light early late quick slow big small tiny huge tall short long wide round flat new old
      young walk run jump swim read write draw sing dance play cook bake laugh dream think learn teach
      help build paint sleep wake drink give take make find keep open close start stop van vase voice
      igloo otter koala panda quilt juice yard zoo
    `),
    medium: words(`
      garden window kitchen bedroom pillow blanket basket bottle button candle carrot cheese cherry
      circle bridge castle forest island jungle desert valley meadow planet rocket orange yellow purple
      silver camera guitar violin trumpet pencil crayon eraser postcard ticket market bakery library
      museum theater school teacher doctor farmer sailor painter singer dancer writer author family
      friend mother father sister brother cousin parent children neighbor morning evening tonight
      weekend holiday birthday summer winter autumn spring weather thunder rainbow sunshine snowman
      snowball puddle breeze sunset sunrise shadow bubble puzzle picture balloon present cookie muffin
      pancake waffle noodle sandwich popcorn pretzel cupcake biscuit cereal yogurt butter pepper tomato
      potato garlic cabbage lettuce spinach pumpkin banana avocado apricot coconut walnut peanut almond
      chicken turkey rabbit turtle donkey monkey giraffe elephant penguin dolphin octopus lobster spider
      beetle parrot pigeon sparrow falcon kitten hamster squirrel hedgehog raccoon bicycle scooter
      tractor airport station harbor highway street corner village country capital office factory
      hospital dentist grocery wallet pocket jacket sweater mitten slipper sandal pajamas computer
      keyboard monitor printer message laptop tablet charger battery remote magnet mirror curtain
      cushion carpet ladder hammer shovel bucket sponge shampoo gentle clever honest polite friendly
      curious careful cheerful helpful patient thankful peaceful playful useful simple special perfect
      famous strange bright golden silent breakfast dinner supper dessert chocolate vanilla caramel
      lemonade coffee kettle teapot saucer napkin blender toaster freezer cupboard drawer journey
      vacation picnic camping fishing painting gardening cooking explore imagine discover remember
      believe whisper giggle wonder travel listen answer question promise welcome goodbye yesterday
      tomorrow minute second moment quarter number twelve twenty thirty hundred thousand million zipper
      zigzag jigsaw juggle kangaroo velvet volcano xylophone unicorn umbrella insect invent oyster
      orchard
    `),
    hard: words(`
      strawberry watermelon grasshopper caterpillar helicopter motorcycle skateboard wheelbarrow
      lighthouse playground background understand everything everywhere television restaurant
      university population environment temperature information imagination celebration conversation
      neighborhood refrigerator encyclopedia photographer grandmother grandfather grandchildren
      thunderstorm marshmallow gingerbread peppermint cheeseburger cauliflower blackberry grapefruit
      clementine pomegranate journalist firefighter electrician veterinarian photograph microscope
      calculator dictionary typewriter headphones microphone loudspeaker flashlight toothbrush
      toothpaste sunglasses skyscraper downstairs countryside earthquake springtime summertime
      wintertime invitation friendship blackboard chalkboard paintbrush sketchbook exploration
      experiment laboratory technology electricity mathematics literature vocabulary punctuation
      difference interesting comfortable incredible impossible remarkable especially absolutely
      definitely immediately eventually unfortunately occasionally particularly independent
      responsible complicated appreciate accomplish communicate concentrate congratulate investigate
      participate opportunity possibility responsibility relationship achievement atmosphere
      experience expression impression decoration illustration construction transportation
      entertainment announcement basketball volleyball trampoline rollercoaster wheelchair supermarket
      marketplace department dishwasher pillowcase greenhouse babysitter grandparents granddaughter
      hummingbird kingfisher chimpanzee rhinoceros hippopotamus salamander questionnaire kindergarten
      nightingale vegetarian wonderland watercolor
    `),
  },
};

const union = (tier: Tier): readonly string[] => [...new Set([...PACKS.tennis[tier], ...PACKS.everyday[tier]])];

const MIXED: Record<Tier, readonly string[]> = { easy: union('easy'), medium: union('medium'), hard: union('hard') };

/** The word list for a pack and tier; 'mixed' is the union of both packs with duplicates removed. */
export function packWords(pack: WordPackId, tier: Tier): readonly string[] {
  return pack === 'mixed' ? MIXED[tier] : PACKS[pack][tier];
}

/** Tier for a word length (easy 3–5, medium 6–9, hard 10–14), or null when no tier fits. */
export function tierOfLength(len: number): Tier | null {
  if (len >= 3 && len <= 5) return 'easy';
  if (len >= 6 && len <= 9) return 'medium';
  if (len >= 10 && len <= 14) return 'hard';
  return null;
}
