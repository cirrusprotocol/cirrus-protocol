use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

// Re-export so the verifying key type is accessible from the program crate
// without a direct dependency on groth16-solana at the call sites.
pub use groth16_solana::groth16::Groth16Verifyingkey;

use crate::zk_vk_withdraw_sol_v1::WITHDRAW_SOL_V1_VK;

pub const WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT: usize = 3;

pub fn verify_withdraw_sol_v1_proof(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs: &[[u8; 32]; WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT],
) -> Result<()> {
    let mut verifier = Groth16Verifier::new(
        proof_a,
        proof_b,
        proof_c,
        public_inputs,
        &WITHDRAW_SOL_V1_VK,
    )
    .map_err(|_| error!(crate::errors::ShieldedPoolError::InvalidProof))?;

    verifier
        .verify()
        .map_err(|_| error!(crate::errors::ShieldedPoolError::InvalidProof))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_boundary_uses_three_public_inputs() {
        assert_eq!(WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT, 3);
    }

    #[test]
    fn groth16_solana_bn254_field_check_accessible() {
        // Zero is always strictly less than the BN254 field modulus.
        assert!(groth16_solana::groth16::is_less_than_bn254_field_size_be(
            &[0u8; 32]
        ));
    }

    #[test]
    fn vk_nr_pubinputs_is_four() {
        assert_eq!(WITHDRAW_SOL_V1_VK.nr_pubinputs, 4);
    }

    #[test]
    fn vk_ic_length_is_four() {
        assert_eq!(WITHDRAW_SOL_V1_VK.vk_ic.len(), 4);
    }
}
