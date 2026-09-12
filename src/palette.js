// One place for every colour in the diorama. Cel shading means flat, saturated
// fills carry the whole look, so these are chosen to stay distinct from one
// another once the toon ramp darkens them.
export const PALETTE = {
  baseTop:    0x9ec96f,   // plinth top (grass showing between features)
  baseSide:   0xc9a27a,   // earth cut-away below the plinth
  green:      0x8dc25f,   // parks, gardens, meadow
  water:      0x74c2e8,
  yard:       0xe8c98a,   // school grounds
  pitch:      0xb6d97a,   // sports pitches / playground
  roadMajor:  0xb8b3aa,
  roadMinor:  0xc6c1b7,
  roadPath:   0xd8cdb6,
  wall:       0xf6efe2,   // ordinary houses
  roof:       0xd4705c,   // terracotta
  schoolWall: 0xf2e7bb,   // the school's pale, almost-white yellow render
  schoolRoof: 0x939ea9,   // its grey flat roofs - not yellow
  hallRoof:   0x8fb3d6,   // the Sporthalle's blue roof
  treeTrunk:  0x8a6a4a,
  treeLeaf:   0x5faa4e,
};

// Sky gradient painted by the composite pass wherever nothing was drawn.
export const SKY_TOP = [0.816, 0.925, 0.973];
export const SKY_BOTTOM = [0.996, 0.965, 0.906];
export const INK = [0.106, 0.157, 0.125];   // outline colour
