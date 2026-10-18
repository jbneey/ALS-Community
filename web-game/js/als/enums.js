/**
 * ALS-Community port — Enum library.
 *
 * Direct JS mirror of Source/ALSV4_CPP/Public/Library/ALSCharacterEnumLibrary.h
 * (UENUM -> frozen objects, values kept in the same order as the C++ enums).
 */

export const EALSGait = Object.freeze({
  Walking: 0,
  Running: 1,
  Sprinting: 2,
});

export const EALSMovementAction = Object.freeze({
  None: 0,
  LowMantle: 1,
  HighMantle: 2,
  Rolling: 3,
  GettingUp: 4,
});

export const EALSMovementState = Object.freeze({
  None: 0,
  Grounded: 1,
  InAir: 2,
  Mantling: 3,
  Ragdoll: 4,
});

export const EALSOverlayState = Object.freeze({
  Default: 0,
  Masculine: 1,
  Feminine: 2,
  Injured: 3,
  HandsTied: 4,
  Rifle: 5,
  PistolOneHanded: 6,
  PistolTwoHanded: 7,
  Bow: 8,
  Torch: 9,
  Binoculars: 10,
  Box: 11,
  Barrel: 12,
});

export const EALSRotationMode = Object.freeze({
  VelocityDirection: 0,
  LookingDirection: 1,
  Aiming: 2,
});

export const EALSStance = Object.freeze({
  Standing: 0,
  Crouching: 1,
});

export const EALSViewMode = Object.freeze({
  ThirdPerson: 0,
  FirstPerson: 1,
});

export const EALSFootstepType = Object.freeze({
  Step: 0,
  WalkRun: 1,
  Jump: 2,
  Land: 3,
});

export const EALSGroundedEntryState = Object.freeze({
  None: 0,
  Roll: 1,
});

export const EALSHipsDirection = Object.freeze({
  F: 0,
  B: 1,
  RF: 2,
  RB: 3,
  LF: 4,
  LB: 5,
});

/**
 * Result of a montage request issued through ALSAnimationProviderInterface.
 * Mirror of EALSAnimationPlayResult (Source/.../ALSAnimationProvider.h).
 */
export const EALSAnimationPlayResult = Object.freeze({
  Played: 0,
  Refused: 1,
  Unavailable: 2,
});

/** Human-readable names for HUD/diagnostics. */
export const EnumNames = Object.freeze({
  Gait: ['Walking', 'Running', 'Sprinting'],
  MovementAction: ['None', 'LowMantle', 'HighMantle', 'Rolling', 'GettingUp'],
  MovementState: ['None', 'Grounded', 'InAir', 'Mantling', 'Ragdoll'],
  RotationMode: ['VelocityDirection', 'LookingDirection', 'Aiming'],
  Stance: ['Standing', 'Crouching'],
  ViewMode: ['ThirdPerson', 'FirstPerson'],
  OverlayState: ['Default', 'Masculine', 'Feminine', 'Injured', 'HandsTied', 'Rifle',
    'PistolOneHanded', 'PistolTwoHanded', 'Bow', 'Torch', 'Binoculars', 'Box', 'Barrel'],
  FootstepType: ['Step', 'WalkRun', 'Jump', 'Land'],
  PlayResult: ['Played', 'Refused', 'Unavailable'],
});
