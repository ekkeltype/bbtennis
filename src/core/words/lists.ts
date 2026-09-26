import type { Tier, WordPackId } from '../types';

/** Splits a whitespace-separated block of words into a list. */
const words = (block: string): readonly string[] => block.trim().split(/\s+/);

/** Curated word packs (spec §3.10); tier = word length: easy 3–5, medium 6–9, hard 10–14. */
export const PACKS: Record<'everyday' | 'sports' | 'dojo', Record<Tier, readonly string[]>> = {
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
      dark light early late quick slow big small tiny huge tall round new old
      young walk run jump swim read write draw sing dance play cook bake laugh dream think learn teach
      help build paint sleep wake drink give take make find keep open close start stop van vase voice
      igloo otter koala panda quilt juice yard zoo puppy bunny pizza melon
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
      tractor airport station harbor highway street village country capital office factory
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
      orchard pebble
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
      entertainment announcement basketball trampoline rollercoaster wheelchair supermarket
      marketplace department dishwasher pillowcase greenhouse babysitter grandparents granddaughter
      hummingbird kingfisher chimpanzee rhinoceros hippopotamus salamander questionnaire kindergarten
      nightingale vegetarian wonderland watercolor applesauce
    `),
  },
  sports: {
    easy: words(`
      goal medal team race relay lap jump swim dive ski skate surf row sail golf polo judo sumo rugby
      yoga chess luge sled rodeo vault derby hike climb jog run dash kayak canoe raft bike cycle wheel
      gear ball bat puck glove cleat mitt pad board oar stick cone hoop rim mat rope baton reins tee
      iron club bib vest kit cap boots shoe visor coach ref fan squad crew pro star champ hero rival
      judge boxer diver rower skier racer rider arena field pitch track pool lane rink slope gym court
      stand bench range trail ring base plate mound oval venue green hole leap hop skip kick throw catch
      dunk tag aim score win lead chase steer pedal glide twirl flip twist tuck pike split pose lift
      squat press curl plank lunge train drill trot dodge flex point game match set tie draw title
      prize cup gold heat final round mile bout rank seed bye tally entry event award cheer crowd roar
      clap fame glory fast quick swift agile fit tough brave bold speed power pace grit sweat torch
      flag card timer sport yard meter ice snow wave buoy boat yacht chalk beam bar
    `),
    medium: words(`
      athlete stadium trophy referee umpire marathon sprinter sprint hurdle javelin discus hammer
      polevault decathlon triathlon biathlon skiing skating surfing rowing sailing cycling swimming
      diving running jogging climbing hiking archery fencing bowling curling hockey soccer football
      baseball softball handball lacrosse cricket badminton squash pingpong boxing wrestling karate
      gymnast cyclist swimmer skater surfer runner golfer player captain goalie keeper pitcher batter
      catcher jockey trainer teammate champion finalist contender underdog rookie veteran legend
      opponent spectator audience applause mascot whistle stopwatch helmet jersey uniform sneakers
      kneepad goalpost racket paddle saddle snowboard surfboard dumbbell barbell treadmill jumprope
      gymnasium racetrack velodrome ballpark clubhouse locker bleachers dugout fairway bunker podium
      medalist victory rematch season league fixture playoff tourney semifinal ranking standings
      scorer penalty hattrick birdie teamwork stamina fitness agility training practice exercise
      warmup stretch endurance sponsor anthem parade ribbon pennant banner fanfare headband wristband
      sweatband tracksuit swimsuit goggles wetsuit shinpad slalom bobsled toboggan snowshoe regatta
      kayaking rafting snorkel lifeguard waterpolo windsurf sailboat hurdler starter dressage gallop
      canter stirrup racehorse boulder harness carabiner summit trekking compass archer target
      bullseye checkmate skydiving parachute tumbling platform icehockey skatepark cricketer
      scrimmage matchday extratime wildcard fairplay athletics racecar dodgeball kickball billiards
      snooker croquet official announcer scorecard supporter manager
    `),
    hard: words(`
      championship gymnastics snowboarding skateboarding basketball pickleball racquetball tabletennis
      kettlebell trampoline pentathlon heptathlon decathlete triathlete triplejump equestrian
      mountaineer orienteering weightlifting powerlifting scoreboard timekeeper scorekeeper
      commentator broadcaster sportscaster groundskeeper cheerleader lifejacket mouthguard tournament
      quarterfinal semifinalist competition competitor athleticism sportsmanship goalkeeper
      wicketkeeper baserunner grandstand motorsport speedskating figureskating fieldhockey rollerskate
      waterskiing windsurfing kitesurfing snorkeling scubadiving paragliding rockclimbing bouldering
      whitewater marathoner racewalking photofinish worldrecord personalbest silvermedal bronzemedal
      titleholder stretching racecourse swimmingpool playingfield footballer golfcourse hockeystick
      baseballbat soccerball tiebreaker handspring somersault balancebeam parallelbars pommelhorse
      unevenbars springboard divingboard bobsledding tobogganing iceskating snowshoeing skijumping
      mountainbike skateboarder snowboarder rowingmachine exercisebike jumpingjack benchpress
      sportswear sweatshirt waterbottle teamspirit trackandfield ultramarathon steeplechase
      showjumping horseriding boxingring boxingglove sumowrestler
    `),
  },
  dojo: {
    easy: words(`
      dojo kata bow belt obi kiai dan kyu mat judo budo zen ninja ronin sumo kendo wushu silat
      sifu kwoon dobok kihap dogi keiko shiai kamae maai ukemi kime waza uke tori nage dachi zuki geri
      tsuki ippon matte yame kohai seiza kihon hyung dohyo shiko godan nidan chi yin yang
      palm elbow knee heel foot hand wrist ankle hip chin spine core toes shin neck chest arm leg head
      heart thumb black white brown green blue red gold gray
      calm focus poise grace honor trust peace hope zeal valor mercy duty loyal kind fair noble wise
      true brave bold tough firm alert aware ready keen grit will mind self vow oath code rule order
      habit still quiet power speed force might vigor flow tempo agile lithe swift quick
      drill form spar bout test exam grade rank level title class study learn teach guide coach pupil
      elder hero rival duel guard grip hold pin lock throw sweep trip hook jab punch kick block parry
      dodge evade feint weave duck roll fall flip twist pivot kneel stand sit reach lunge squat hop
      leap jump dash step slide glide stamp stomp clap shout bell robe sash gong drum ink brush tea
      monk bag pad board brick rope bench gate hall path way art skill style combo
      tiger crane snake eagle horse bear lotus
    `),
    medium: words(`
      sensei senpai karate aikido taekwondo jujitsu jiujitsu kumite randori samurai bushido tatami
      hakama dojang kimono judoka karateka aikidoka kendoka hapkido capoeira savate boxing wrestling
      grappling muaythai kungfu qigong taichi sanshou kyorugi poomsae tangsoodo rikishi yokozuna
      mawashi tachiai kuzushi zanshin mushin shodan sandan shihan hajime mokuso dojokun
      master student teacher mentor lesson grading promotion ceremony etiquette tradition diploma
      emblem stripe blackbelt whitebelt greenbelt brownbelt bluebelt redbelt headband uniform headgear
      shinguard sandbag lantern bamboo scroll pagoda temple garden bonsai warrior guardian champion
      opponent partner dragon phoenix leopard mantis monkey serpent panther
      respect courage patience strength breathing balance focused mindful breath inhale exhale
      posture honesty kindness modesty sincere virtue resolve tenacity bravery valiant steadfast
      devotion diligent practice training stamina agility control timing rhythm footwork reflex
      awareness alertness readiness calmness stillness humility gratitude loyalty honorable fairness
      integrity wisdom insight clarity harmony serenity tranquil composure rectitude sincerity
      energy spirit stance strike counter defense sparring grapple clinch wrestle tumble evasion
      deflect meditate breathe bowing kneeling handstand cartwheel footsweep cranekick jumpkick
      hipthrow armlock wristlock headlock legsweep breakfall tigerclaw catstance sidekick kickboxer
    `),
    hard: words(`
      grandmaster discipline meditation roundhouse kickboxing somersault stretching shadowboxing
      martialarts martialartist breathwork mindfulness tranquility respectful politeness dedication
      commitment resilience apprentice instructor demonstration flyingkick crescentkick palmstrike
      kneestrike elbowstrike counterattack groundwork shoulderthrow shoulderroll horsestance
      cranestance boardbreaking conditioning reactiontime combination mouthguard masterclass
      punchingbag yellowbelt orangebelt purplebelt calligraphy certificate perseverance determination
      concentration selfcontrol selfdefense selfdiscipline selfrespect selfbelief selfmastery
      confidence persistence courageous peacefulness gentleness kindhearted trustworthy dependable
      reliability steadiness equilibrium coordination flexibility nimbleness motivation inspiration
      achievement improvement progression repetition fundamentals innerpeace innerstrength equanimity
      harmonious traditional philosophy benevolence compassion sumowrestler tornadokick butterflykick
      sweepingkick handspring wrestlingmat gratefulness thankfulness kungfumaster taichichuan
      beltpromotion stancework breathcontrol humbleness attentiveness watchfulness fearlessness
    `),
  },
};

/**
 * Words naming a shot, stroke, spin, shot outcome or direction, plus their obvious forms (spec §3.10). A typed
 * word must never contradict where the ball goes, so no pack may contain one; tests enforce this by exact
 * match, so longer innocent words that merely contain a short entry (lobster, network) stay allowed.
 */
export const MISLEADING_WORDS: ReadonlySet<string> = new Set(words(`
  forehand forehands backhand backhands lob lobs lobbed lobbing volley volleys volleyed volleying halfvolley
  dropvolley smash smashes smashed smashing overhead overheads slice slices sliced slicing dropshot dropshots
  drop drops dropped passingshot passingshots pass passes passing groundstroke groundstrokes approach
  approaches approachshot return returns returned serve serves served shot shots stroke strokes drive drives
  chip chips tweener moonball
  topspin backspin underspin sidespin spin spins flat
  ace aces aced winner winners fault faults doublefault footfault out net netted let error errors
  unforcederror forcederror miss missed
  left right wide wider short shorter deep deeper long longer high higher low lower middle center centre
  corner corners line lines baseline baselines sideline sidelines down across straight inside outside cross
  crosscourt diagonal angle angles angled forward backward sideways back front body half
`));

const union = (tier: Tier): readonly string[] => [
  ...new Set([...PACKS.everyday[tier], ...PACKS.sports[tier], ...PACKS.dojo[tier]]),
];

const MIXED: Record<Tier, readonly string[]> = { easy: union('easy'), medium: union('medium'), hard: union('hard') };

/** The word list for a pack and tier; 'mixed' is the union of the three packs with duplicates removed. */
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
