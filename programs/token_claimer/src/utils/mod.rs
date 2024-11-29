/// This mod contains functions that validate that an instruction
/// is constructed the way we expect. In this case, this is for
/// `Ed25519Program.createInstructionWithPublicKey()`.
pub mod ed25519;

pub use ed25519::*;
