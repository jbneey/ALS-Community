// Copyright:       Copyright (C) 2022 Doğa Can Yanıkoğlu
// Source Code:     https://github.com/dyanikoglu/ALS-Community


#pragma once

#include "CoreMinimal.h"
#include "UObject/Interface.h"
#include "Library/ALSCharacterStructLibrary.h"

#include "ALSAnimationProvider.generated.h"

class UAnimMontage;
class USkeletalMeshComponent;

/**
 * Result of a montage request issued through UALSAnimationProviderInterface.
 */
UENUM(BlueprintType)
enum class EALSAnimationPlayResult : uint8
{
	/** Animation system accepted and started the request */
	Played UMETA(DisplayName = "Played"),
	/** Animation system refused the request (busy, invalid asset, etc.) */
	Refused UMETA(DisplayName = "Refused"),
	/** No animation system available for this provider */
	Unavailable UMETA(DisplayName = "Unavailable")
};

/**
 * Optional interface that decouples the ALS locomotion logic from Unreal Engine's
 * skeletal animation system (UAnimInstance / montages).
 *
 * ALS is primarily built for Unreal Engine, where ACharacter already provides an
 * integrated Skeletal Mesh + Anim Blueprint pipeline, so the default implementation
 * (UALSBaseCharacter) satisfies this interface internally by using GetMesh()->GetAnimInstance().
 *
 * If you want to run the ALS state machine / movement logic inside another engine or
 * on a custom rendering stack (Godot, Unity, WebGPU-based engines, dedicated servers
 * without any visuals, etc.), implement this interface on your own actor/component and
 * ALS will route every animation request (rolls, get-up, mantle montages, pose snapshots,
 * curve reads) through it instead of touching UAnimInstance directly.
 *
 * Notes for non-Unreal consumers:
 * - All times are in seconds, play rates are multipliers of the source animation length.
 * - "Montage" simply means "a one-shot animation segment with optional start offset".
 * - Returning false / EALSAnimationPlayResult::Refused is always safe; ALS gameplay
 *   logic (movement, networking, ragdoll state) does not depend on the visual result.
 */
UINTERFACE(BlueprintType, MinimalAPI)
class UALSAnimationProviderInterface : public UInterface
{
	GENERATED_BODY()
};

class ALSV4_CPP_API IALSAnimationProviderInterface
{
	GENERATED_BODY()

public:
	/** Play a one-shot animation segment ("montage"). Called for rolls, get-up and mantle animations. */
	UFUNCTION(BlueprintNativeEvent, Category = "ALS|Animation Provider")
	EALSAnimationPlayResult ALS_PlayMontage(UAnimMontage* Montage, float PlayRate, float StartingPosition);

	/** Stop the currently playing animation segment with the given blend-out time. */
	UFUNCTION(BlueprintNativeEvent, Category = "ALS|Animation Provider")
	void ALS_StopMontage(float BlendOutTime);

	/** Store the current pose under a name so it can be blended out of later (ragdoll -> get up). */
	UFUNCTION(BlueprintNativeEvent, Category = "ALS|Animation Provider")
	void ALS_SavePoseSnapshot(FName SnapshotName);

	/** Read an animation curve value (footstep masking, rotation amounts, etc.). */
	UFUNCTION(BlueprintNativeEvent, Category = "ALS|Animation Provider")
	float ALS_GetCurveValue(FName CurveName) const;

	/** Provide the skeletal mesh component used for socket lookups (pelvis position, first person camera socket). */
	UFUNCTION(BlueprintNativeEvent, Category = "ALS|Animation Provider")
	USkeletalMeshComponent* ALS_GetVisualMeshComponent() const;
};
