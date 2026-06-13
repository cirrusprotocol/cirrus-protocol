use anchor_lang::prelude::*;
use solana_program::pubkey;
use solana_program::sysvar::instructions::{
    load_current_index_checked,
    load_instruction_at_checked,
};

use crate::errors::ShieldedPoolError;
use crate::state::VerifierConfig;

const ED25519_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
const ED25519_OFFSET_STRUCT_SIZE: usize = 14;
const PUBKEY_SIZE: usize = 32;
const SIGNATURE_SIZE: usize = 64;
const U16_MAX: u16 = u16::MAX;

/// Verify that enough unique, authorized Ed25519 signatures over
/// `expected_message` precede the current instruction in the transaction.
///
/// Returns the number of unique verified signers on success.
pub fn verify_contiguous_threshold_attestation(
    instructions_sysvar: &AccountInfo,
    expected_message: &[u8],
    config: &VerifierConfig,
) -> Result<u8> {
    require!(
        (config.threshold as usize) <= 8,
        ShieldedPoolError::InvalidAccountData
    );

    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| ShieldedPoolError::InvalidAccountData)?;

    let mut found_verifiers = [Pubkey::default(); 8];
    let mut unique_count: usize = 0;

    for i in 0..current_index {
        let ix = load_instruction_at_checked(i as usize, instructions_sysvar)
            .map_err(|_| ShieldedPoolError::InvalidAccountData)?;

        if ix.program_id != ED25519_ID {
            continue;
        }

        let data = ix.data.as_slice();
        if data.len() < 2 {
            return Err(ShieldedPoolError::InvalidAccountData.into());
        }

        let num_sigs = data[0] as usize;
        if num_sigs == 0 || num_sigs > 8 {
            return Err(ShieldedPoolError::InvalidAccountData.into());
        }

        let offsets_start: usize = 2;
        let offsets_end = offsets_start
            .checked_add(num_sigs * ED25519_OFFSET_STRUCT_SIZE)
            .ok_or(ShieldedPoolError::InvalidAccountData)?;

        if data.len() < offsets_end {
            return Err(ShieldedPoolError::InvalidAccountData.into());
        }

        for sig_idx in 0..num_sigs {
            let base = offsets_start + sig_idx * ED25519_OFFSET_STRUCT_SIZE;

            let sig_offset = read_u16_le(data, base)?;
            let sig_ix = read_u16_le(data, base + 2)?;
            let pubkey_offset = read_u16_le(data, base + 4)?;
            let pubkey_ix = read_u16_le(data, base + 6)?;
            let msg_offset = read_u16_le(data, base + 8)?;
            let msg_size = read_u16_le(data, base + 10)? as usize;
            let msg_ix = read_u16_le(data, base + 12)?;

            if sig_ix != U16_MAX || pubkey_ix != U16_MAX || msg_ix != U16_MAX {
                continue;
            }

            let sig_offset = sig_offset as usize;
            let pubkey_offset = pubkey_offset as usize;
            let msg_offset = msg_offset as usize;

            let sig_end = sig_offset
                .checked_add(SIGNATURE_SIZE)
                .ok_or(ShieldedPoolError::InvalidAccountData)?;
            let pubkey_end = pubkey_offset
                .checked_add(PUBKEY_SIZE)
                .ok_or(ShieldedPoolError::InvalidAccountData)?;
            let msg_end = msg_offset
                .checked_add(msg_size)
                .ok_or(ShieldedPoolError::InvalidAccountData)?;

            if sig_end > data.len() || pubkey_end > data.len() || msg_end > data.len() {
                return Err(ShieldedPoolError::InvalidAccountData.into());
            }

            let actual_message = &data[msg_offset..msg_end];
            if actual_message != expected_message {
                continue;
            }

            let mut pk_bytes = [0u8; PUBKEY_SIZE];
            pk_bytes.copy_from_slice(&data[pubkey_offset..pubkey_end]);
            let signer = Pubkey::new_from_array(pk_bytes);

            if !config.verifier_pubkeys.iter().any(|k| *k == signer) {
                continue;
            }

            let mut already_counted = false;
            for j in 0..unique_count {
                if found_verifiers[j] == signer {
                    already_counted = true;
                    break;
                }
            }

            if !already_counted {
                found_verifiers[unique_count] = signer;
                unique_count += 1;
            }
        }
    }

    require!(
        unique_count >= config.threshold as usize,
        ShieldedPoolError::AttestationFailed
    );

    Ok(unique_count as u8)
}

#[inline(always)]
fn read_u16_le(data: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or(ShieldedPoolError::InvalidAccountData)?;
    let slice = data
        .get(offset..end)
        .ok_or(ShieldedPoolError::InvalidAccountData)?;
    let bytes: [u8; 2] = slice
        .try_into()
        .map_err(|_| ShieldedPoolError::InvalidAccountData)?;
    Ok(u16::from_le_bytes(bytes))
}