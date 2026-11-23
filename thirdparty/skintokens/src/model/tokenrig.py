from copy import deepcopy
from pathlib import Path
from torch import nn, Tensor, FloatTensor
from torch.nn.functional import pad
from transformers import AutoModelForCausalLM, AutoConfig, LogitsProcessor, LogitsProcessorList # type: ignore
from typing import Dict, List, Tuple

import math
import numpy as np
import torch
import torch.nn.functional as F

LLM_LOCAL_DIR = Path("models/Qwen3-0.6B")

from .skin_vae_model import SkinVAEModel
from .skin_vae.autoencoders import SkinFSQCVAEModel
from .spec import ModelSpec, ModelInput, VaeInput, TokenRigResult
from .parse_encoder import MAP_MESH_ENCODER, get_mesh_encoder

from ..rig_package.info.asset import Asset
from ..tokenizer.spec import Tokenizer
from ..tokenizer.spec import DetokenizeOutput
from ..tokenizer.parse import get_tokenizer

try:
    from flash_attn_interface import flash_attn_func # type: ignore
except Exception as e:
    from flash_attn.flash_attn_interface import flash_attn_func as _flash_attn_func
    def flash_attn_func(*args, **kwargs):
        res = _flash_attn_func(*args, **kwargs)
        return res, None

class VocabSwitchingLogitsProcessor(LogitsProcessor):
    def __init__(self, tokenizer: Tokenizer, switch_token_id, eos_token_id, tokens_per_skin, init):
        # make sure all skin tokens > switch_token_id
        self.tokenizer = tokenizer
        self.switch_token_id = switch_token_id
        self.eos_token_id = eos_token_id
        self.tokens_per_skin = tokens_per_skin
        self.init = init

    def __call__(self, input_ids: Tensor, scores: FloatTensor) -> FloatTensor:
        # input_ids shape: (batch_size, seq_len)
        for batch_idx, sequence in enumerate(input_ids):
            mask = torch.full_like(scores[batch_idx], float('-inf'))
            sequence = torch.cat([self.init, sequence])
            length = len(sequence)
            if self.switch_token_id in sequence:
                mask[self.switch_token_id:] = 0
                where = torch.where(sequence == self.switch_token_id)[0][:1]
                J = self.tokenizer.bones_in_sequence(ids=sequence.detach().cpu().numpy())
                if (length-where) == J*self.tokens_per_skin:
                    mask[:] = float('-inf')
                    mask[self.eos_token_id] = 0
                else:
                    mask[self.eos_token_id] = float('-inf')
            else:
                tokens = self.tokenizer.next_posible_token(ids=sequence.detach().cpu().numpy())
                mask[tokens] = 0
            scores[batch_idx] = scores[batch_idx] + mask
        return scores

class TokenRig(ModelSpec):

    def __init__(self, model_config, transform_config, tokenizer_config=None):
        assert tokenizer_config is not None
        super().__init__(model_config=model_config, transform_config=transform_config, tokenizer_config=tokenizer_config)
        
        cfg = self.model_config
        
        self.tokens_per_skin: int = cfg['tokens_per_skin']
        self.tokens_skin_cond: int = cfg['tokens_skin_cond']

        self.use_rope: bool = cfg.get('use_rope', True)
        self.encode_repeat: int = cfg.get('encode_repeat', 4)
        
        self.skin_warmup_start_epoch: int = cfg.get('skin_warmup_start_epoch', 0)
        self.skin_warmup_end_epoch: int = cfg.get('skin_warmup_end_epoch', -1)

        self.vae = SkinVAEModel.load_from_system_checkpoint(cfg['pretrained_vae']).to(torch.bfloat16)
        for param in self.vae.parameters():
            param.requires_grad_(False)
        self.vae.eval()
        
        self.mesh_encoder = get_mesh_encoder(**cfg['mesh_encoder'])
        
        assert (
            isinstance(self.mesh_encoder, MAP_MESH_ENCODER.michelangelo) or
            isinstance(self.mesh_encoder, MAP_MESH_ENCODER.michelangelo_encoder)
        )
        self.mesh_encoder = self.mesh_encoder.to(torch.bfloat16)
        
        self.tokenizer: Tokenizer = get_tokenizer(**tokenizer_config)
        # (tokenizer codebook, fsq vae codebook)
        self.vocab_size = self.tokenizer.vocab_size + self.vae.vocab_size + 1
        self.eos = self.vocab_size - 1
        
        _d = cfg['llm'].copy()
        self.hidden_size = _d['hidden_size']

        _d['vocab_size'] = self.vocab_size
        if LLM_LOCAL_DIR.exists():
            _d['pretrained_model_name_or_path'] = str(LLM_LOCAL_DIR)
        llm_config = AutoConfig.from_pretrained(**_d)
        self.vocab_size = self.tokenizer.vocab_size + self.vae.vocab_size + 1
        llm_config.torch_dtype = torch.bfloat16
        llm_config.pre_norm = True
        self.llm_config = llm_config
        self.transformer = AutoModelForCausalLM.from_config(config=llm_config, attn_implementation="flash_attention_2").to(torch.bfloat16)
        
        self.output_proj = nn.Sequential(
            nn.Linear(self.mesh_encoder.width, self.hidden_size),
            nn.RMSNorm(self.hidden_size),
        ).to(torch.bfloat16)
        
        init_scale = cfg.get('init_scale', None)
        if init_scale is not None:
            self.initialize_weights(init_scale)
    
    def compile_model(self):
        self.vae.compile_model()
        self.transformer = torch.compile(self.transformer, dynamic=False)
        self.mesh_encoder = torch.compile(self.mesh_encoder, dynamic=False)
        
    def initialize_weights(self, s: float):
        def init_linear(l, stddev):
            nn.init.normal_(l.weight, std=stddev)
            if l.bias is not None:
                nn.init.constant_(l.bias, 0.0)
        init_scale = s * math.sqrt(1.0 / self.mesh_encoder.width)

        for m in self.mesh_encoder.modules():
            if isinstance(m, nn.Linear):
                init_linear(m, stddev=init_scale)
        init_scale = s * math.sqrt(1.0 / self.hidden_size)
        for m in self.output_proj.modules():
            if isinstance(m, nn.Linear):
                init_linear(m, stddev=init_scale)
    
    def get_skin_warmup_rate(self, steps_per_epoch: int) -> float:
        if self.current_epoch < self.skin_warmup_start_epoch:
            return 0.
        if self.current_epoch > self.skin_warmup_end_epoch:
            return 1.
        start_steps = self.skin_warmup_start_epoch * steps_per_epoch
        end_steps = (self.skin_warmup_end_epoch+1) * steps_per_epoch
        rate = (self.global_step-start_steps) / (end_steps-start_steps)
        return min(max((1.0-math.cos(math.pi * rate))/2, 0), 1)

    @torch.autocast(device_type='cuda', dtype=torch.bfloat16)
    def training_step(self, batch: Dict) -> Dict:
        raise NotImplementedError()
    
    def make_start_tokens(self, **kwargs) -> List[List[int]]:
        skeleton_tokens = kwargs.get('skeleton_tokens', None)
        skeleton_mask = kwargs.get('skeleton_mask', None)
        num_joints = kwargs.get('num_joints', None)
        parents = kwargs.get('parents', None)
        cls = kwargs.get('cls', None)
        start_tokens_list = []
        
        batch_size = 1
        if skeleton_tokens is not None:
            batch_size = len(skeleton_tokens)
        elif cls is not None:
            batch_size = len(cls)
        elif num_joints is not None:
            batch_size = len(num_joints)
        elif parents is not None:
            batch_size = len(parents)
        else:
            assert 0, "must provide one of skeleton_tokens, cls, num_joints, parents"
        for i in range(batch_size):
            if skeleton_tokens is not None:
                _skeleton_tokens = skeleton_tokens[i]
                _skeleton_mask = skeleton_mask[i] if skeleton_mask is not None else None
                assert _skeleton_tokens[0] == self.tokenizer.bos
                if skeleton_mask is not None:
                    start_tokens = _skeleton_tokens[_skeleton_mask==1]
                else:
                    start_tokens = _skeleton_tokens
            else:
                start_tokens = [self.tokenizer.bos]
                start_tokens += self.tokenizer.make_cls_head(
                    cls=cls[i] if cls is not None else None,
                    num_joints=num_joints[i] if num_joints is not None else None,
                    parents=parents[i] if parents is not None else None,
                )
            if isinstance(start_tokens, Tensor):
                start_tokens = start_tokens.detach().cpu().numpy().tolist()
            start_tokens_list.append(start_tokens)
        return start_tokens_list
    
    @torch.autocast(device_type='cuda', dtype=torch.bfloat16)
    def generate(
        self,
        vertices: Tensor,
        normals: Tensor,
        cls: str|None=None,
        skeleton_tokens: np.ndarray|Tensor|None=None,
        only_ids: bool=False,
        return_decode_dict: bool=False,
        num_joints: int|None=None,
        parents: Tensor|None=None,
        **kwargs,
    ) -> TokenRigResult:
        """
        Do not support batch!
        """
        assert isinstance(self.vae.model, SkinFSQCVAEModel)
        assert vertices.dim() == 2, 'do not support batch'
        assert normals.dim() == 2, 'do not support batch'
        
        if isinstance(skeleton_tokens, np.ndarray):
            skeleton_tokens = torch.from_numpy(skeleton_tokens).to(self.device)
        
        cond = torch.cat([vertices, normals], dim=-1).unsqueeze(0)
        _, cond_latents = self.vae.model._encode(
            x=None,
            cond=cond,
            num_tokens=self.tokens_per_skin,
            cond_tokens=self.tokens_skin_cond,
            return_z=False,
        )
        assert cond_latents is not None
        # (1, len, dim)
        learned_mesh_cond = encode_mesh_cond(self.mesh_encoder, self.output_proj, self.tokens_skin_cond, {'vertices': vertices, 'normals': normals})
        
        device = cond.device
        start_tokens = torch.tensor(self.make_start_tokens(
            device=device,
            cls=None if cls is None else [cls],
            skeleton_tokens=None if skeleton_tokens is None else [skeleton_tokens],
            num_joints=None if num_joints is None else [num_joints],
            parents=None if parents is None else [parents],
        )[0], device=device).unsqueeze(0)
        assert start_tokens.shape[0] == 1
        start_embed = self.transformer.get_input_embeddings()(start_tokens)
        # Everything here is bfloat16, but the LLM's input must be pinned to the
        # transformer's own dtype anyway: torch >= 2.12 runs `nn.RMSNorm` in fp32
        # under autocast (the policy `nn.LayerNorm` has always had), and
        # `output_proj` ends in one — so `learned_mesh_cond` comes back fp32 on a
        # newer torch even though every weight on the path is bf16. A fp32 prefill
        # fills the KV cache with fp32 keys; the next decode step's query is bf16
        # (a plain embedding lookup, which autocast leaves alone) and flash-attn
        # rejects the pair with "query and key must have the same dtype". The
        # prefill itself survives because transformers casts a fp32 *query* down
        # for flash-attn but never rewrites the cache it already wrote.
        llm_dtype = self.transformer.get_input_embeddings().weight.dtype
        inputs_embeds = torch.cat(
            [learned_mesh_cond.to(llm_dtype), start_embed.to(llm_dtype)], dim=1
        )
        
        results = self.transformer.generate(
            inputs_embeds=inputs_embeds,
            bos_token_id=self.tokenizer.bos,
            eos_token_id=self.eos,
            pad_token_id=self.tokenizer.pad,
            logits_processor=get_logits_processor(
                tokenizer=self.tokenizer,
                eos=self.eos,
                tokens_per_skin=self.tokens_per_skin,
                start_tokens=start_tokens[0],
            ),
            **kwargs,
        )
        
        res = TokenRigResult()
        output_ids = results[0, :]
        for token in reversed(start_tokens[0]):
            v = token.item()
            output_ids = pad(output_ids, (1, 0), value=v)
        res.input_ids = start_tokens[0]
        res.output_ids = output_ids
        if only_ids:
            return res
        res.cond = cond[0]
        res.cond_latents = cond_latents[0]
        if return_decode_dict:
            return res
        d = decode(
            cond=cond[0],
            cond_latents=cond_latents[0],
            inputs_ids=output_ids,
            tokenizer=self.tokenizer,
            tokens_per_skin=self.tokens_per_skin,
            vae=self.vae,
        )
        res.skin_pred = d['skin_pred']
        res.detokenize_output = d['detokenize_output']
        return res

    def _debug_export(
        self,
        batch: Dict,
        cond: Tensor,
        cond_latents: Tensor,
        inputs_ids: Tensor,
        id: int=0,
        path: str='res.fbx',
    ):
        if inputs_ids.dim() == 2:
            assert cond_latents.dim() == cond.dim() == 3, f"Expected 3 dimensions, got {cond_latents.dim()}, {cond.dim()}"
            cond = cond[id]
            cond_latents = cond_latents[id]
            inputs_ids = inputs_ids[id]
        res = decode(
            cond=cond,
            cond_latents=cond_latents,
            inputs_ids=inputs_ids,
            tokenizer=self.tokenizer,
            tokens_per_skin=self.tokens_per_skin,
            vae=self.vae,
        )
        detokenize_output: DetokenizeOutput = res['detokenize_output']
        origin_asset: Asset = batch['model_input'][id].asset
        asset = Asset.from_data(
            vertices=origin_asset.vertices,
            faces=origin_asset.faces,
            sampled_vertices=batch['vertices'][id].detach().cpu().numpy(),
            sampled_skin=res['skin_pred'].detach().cpu().numpy(),
            parents=np.array(detokenize_output.parents),
            joint_names=detokenize_output.joint_names,
            joints=detokenize_output.joints,
        )
        from ..rig_package.parser.bpy import BpyParser
        BpyParser.export_asset(asset, filepath=path)
    
    def process_fn(self, batch: List[ModelInput]) -> List[Dict]:
        res = []
        max_length = 0
        for b in batch:
            if b.tokens is not None:
                max_length = max(max_length, b.tokens.shape[0])
        res = []
        for b in batch:
            if b.tokens is not None:
                skeleton_tokens = np.pad(b.tokens, ((0, max_length-b.tokens.shape[0])), 'constant', constant_values=self.tokenizer.pad)
                skeleton_mask = np.pad(np.ones_like(b.tokens), ((0, max_length-b.tokens.shape[0])), 'constant', constant_values=0)
            else:
                skeleton_tokens = None
                skeleton_mask = None
            _d = {
                'vertices': torch.from_numpy(b.asset.sampled_vertices).float(),
                'normals': torch.from_numpy(b.asset.sampled_normals).float(),
                'non': {
                    'cls': b.asset.cls,
                }
            }
            if skeleton_mask is not None:
                _d.update({
                    'skeleton_tokens': skeleton_tokens,
                    'skeleton_mask': skeleton_mask,
                })
                _d['non'].update({
                    'parents': b.asset.parents,
                    'num_bones': b.asset.J,
                })
            if b.asset.sampled_vertex_groups is not None and 'skin' in b.asset.sampled_vertex_groups:
                assert b.asset.meta is not None
                _d['non'].update({
                    'cls': b.asset.cls,
                    'uniform_skin': torch.from_numpy(b.asset.sampled_vertex_groups['skin']).float(),
                    'skin_samples': b.asset.skin_samples,
                    'dense_indices': b.asset.meta['dense_indices'],
                    'dense_skin': torch.from_numpy(b.asset.meta['dense_skin']).float(),
                    'dense_vertices': torch.from_numpy(b.asset.meta['dense_vertices']).float(),
                    'dense_normals': torch.from_numpy(b.asset.meta['dense_normals']).float(),
                })
            res.append(_d)
        return res
    
    def predict_step(
        self,
        batch: Dict,
        no_cls: bool=False,
        skeleton_tokens=None,
        parents=None,
        num_joints=None,
        make_asset: bool=False,
        **kwargs
    ) -> Dict:
        vertices: Tensor   = batch['vertices']
        normals : Tensor   = batch['normals']
        cls = batch['cls']
        generate_kwargs = deepcopy(batch['generate_kwargs'])

        if vertices.dim() == 2:
            vertices = vertices.unsqueeze(0)
            normals  = normals.unsqueeze(0)
        results = []
        if skeleton_tokens is None:
            skeleton_tokens = [None] * vertices.shape[0]
        d = {}
        for i in range(vertices.shape[0]):
            res = self.generate(
                vertices=vertices[i],
                normals=normals[i],
                skeleton_tokens=skeleton_tokens[i],
                cls=None if no_cls else cls[i],
                parents=None if parents is None else parents[i],
                num_joints=None if num_joints is None else num_joints[i],
                **generate_kwargs
            )
            if make_asset:
                assert 'model_input' in batch, "need model_input to make asset (in validate/predict mode)"
                assert res.detokenize_output is not None
                if res.skin_pred is None:
                    J = res.detokenize_output.joints.shape[0]
                    raise RuntimeError(
                        f"The rig ran out of token budget: it generated a {J}-joint skeleton but "
                        f"generation stopped before all its skin weights were written. "
                        f"Run Auto Rig again (each run samples a different skeleton), or lower "
                        f"Length penalty so it favours fewer bones."
                    )
                asset: Asset = batch['model_input'][i].asset.copy()
                res.asset = Asset.from_data(
                    vertices=asset.vertices,
                    faces=asset.faces,
                    sampled_vertices=vertices[i].detach().float().cpu().numpy(),
                    sampled_skin=res.skin_pred.detach().float().cpu().numpy(),
                    joints=res.detokenize_output.joints,
                    parents=np.array(res.detokenize_output.parents),
                    cls=asset.cls,
                    path=asset.path,
                )
            results.append(res)
        d['results'] = results
        return d
    
    def forward(self, batch: Dict) -> Dict[str, Tensor]:
        return self.training_step(batch=batch)

def _check(x: Tensor, s, m=None):
    assert isinstance(s, (list, tuple)), "Expected shape must be a list or tuple"
    assert x.dim() == len(s), f"Expected {len(s)} dims, got {x.dim()}"
    for i, (dim_actual, dim_expected) in enumerate(zip(x.shape, s)):
        if dim_expected is not None and dim_expected != -1:
            if m is None:
                assert dim_actual == dim_expected, f"Shape mismatch at dim {i}: expected {dim_expected}, got {dim_actual}"
            else:
                assert dim_actual == dim_expected, f"Shape mismatch at dim {i}: expected {dim_expected}, got {dim_actual}. Message: {m}"

def encode_mesh_cond(mesh_encoder, output_proj, tokens_skin_cond, batch: Dict) -> Tensor:
    vertices = batch['vertices'] # (B, N, 3)
    normals = batch['normals'] # (B, N, 3)
    assert isinstance(vertices, Tensor)
    assert isinstance(normals, Tensor)
    if (len(vertices.shape) == 3):
        shape_embed, latents, token_num, pre_pc = mesh_encoder.encode_latents(pc=vertices, feats=normals) # type: ignore
    else:
        shape_embed, latents, token_num, pre_pc = mesh_encoder.encode_latents(pc=vertices.unsqueeze(0), feats=normals.unsqueeze(0)) # type: ignore
    latents = output_proj(latents)
    return latents

@torch.no_grad()
def encode(
    tokenizer: Tokenizer,
    vae: SkinVAEModel,
    vae_input: VaeInput,
    encode_repeat: int,
    tokens_skin_cond: int,
    tokens_per_skin: int,
) -> Tuple[Tensor, Tensor, Tensor]:
    """
    Returns:
        skin_tokens: (B, tokens_per_skin*J)
        
        cond_latents: (B, tokens_skin_cond, vae.latent_channels)
        
        skin_mask: (B, tokens_per_skin*J), 1 -> skin, 0 -> pad
    """
    device = vae_input.uniform_cond.device
    B = vae_input.B
    J = vae_input.max_J
    _, cond_latents, codes, _ = vae.encode(vae_input=vae_input, num_tokens=tokens_per_skin, full=True, encode_repeat=encode_repeat)
    codes = codes[:, :tokens_per_skin]
    indices = vae_input.get_flatten_indices()
    
    skin_tokens = torch.full((B, J * tokens_per_skin), tokenizer.pad, dtype=torch.long, device=device)
    skin_mask = torch.zeros_like(skin_tokens, dtype=torch.long)
    j_counters = [0 for _ in range(B)]
    for idx, batch_id in enumerate(indices):
        j = j_counters[batch_id]
        s = j * tokens_per_skin
        t = s + tokens_per_skin
        skin_tokens[batch_id, s:t] = codes[idx] + tokenizer.vocab_size
        skin_mask[batch_id, s:t] = 1
        j_counters[batch_id] += 1
    
    assert cond_latents is not None
    _check(cond_latents, (B, tokens_skin_cond, vae.latent_channels))
    _check(skin_tokens, (B, J * tokens_per_skin))
    _check(skin_mask, (B, J * tokens_per_skin))
    return skin_tokens, cond_latents, skin_mask

def prepare_llm_tokens(
    tokenizer: Tokenizer,
    eos: int,
    skeleton_tokens: Tensor,
    skeleton_mask: Tensor,
    skin_tokens: Tensor,
    skin_mask: Tensor,
    cond_latents: Tensor,
) -> Tuple[Tensor, Tensor, Tensor, Tensor]:
    """
    Args:
        skeleton_tokens: (B, n)
        
        skeleton_mask: (B, n)
        
        skin_tokens: (B, tokens_per_skin*J)
        
        skin_mask: (B, tokens_per_skin*J)
        
        cond_latents: (B, tokens_skin_cond, vae.latent_channels)

    Returns:
        llm_tokens: (B, seq_len)
        
        attention_mask: (B, seq_len), 1 -> attend, 0 -> pad
    """
    B = skeleton_tokens.shape[0]
    inputs_ids = torch.ones((B, skeleton_tokens.shape[1] + skin_tokens.shape[1] + 1), dtype=torch.long, device=skeleton_tokens.device) * tokenizer.pad
    num_skeleton = skeleton_mask.sum(dim=1)
    num_skin = skin_mask.sum(dim=1)
    attention_mask = torch.ones((B, inputs_ids.shape[1]), dtype=torch.float32, device=skeleton_tokens.device)
    llm_skeleton_mask = torch.ones_like(attention_mask, dtype=torch.bool)
    llm_skin_mask = torch.ones_like(attention_mask, dtype=torch.bool)
    for i in range(B):
        length = num_skeleton[i] + num_skin[i]
        inputs_ids[i, :num_skeleton[i]] = skeleton_tokens[i, :num_skeleton[i]]
        inputs_ids[i, num_skeleton[i]:num_skeleton[i]+num_skin[i]] = skin_tokens[i, :num_skin[i]]
        inputs_ids[i, num_skeleton[i]+num_skin[i]] = eos   # add an eos
        attention_mask[i, length+1:] = 0.
        llm_skeleton_mask[i, num_skeleton[i]:] = 0
        llm_skin_mask[i, :num_skeleton[i]] = 0
        llm_skin_mask[i, length+1:] = 0
    
    seq_len = inputs_ids.shape[1]
    _check(inputs_ids, (B, seq_len))
    _check(attention_mask, (B, seq_len))
    return inputs_ids, attention_mask, llm_skeleton_mask, llm_skin_mask

class CudaCacheTrimProcessor(LogitsProcessor):
    """Leaves the scores alone; every few decode steps it hands PyTorch's cached
    but unused GPU blocks back to the driver.

    The KV cache grows by one token per step for every beam, and each step's
    cache tensors are slightly bigger than the ones they replace, so the caching
    allocator cannot reuse the freed blocks and keeps reserving new ones.
    Measured with 15 beams: at 1000 tokens, 3.35 GB in use but 17.4 GB
    reserved. A humanoid rig stops at ~400 tokens and never notices. A
    many-legged mesh (a crab: 150 joints, 1000+ tokens) does — and on Windows
    the driver spills past physical VRAM into system RAM instead of raising
    OOM, so the run slows to a crawl while VRAM climbs and never finishes.
    `expandable_segments` would avoid the fragmentation but is Linux-only.
    Trimming every 16 steps keeps reservation within ~0.5 GB of real use, at no
    measurable cost (a static KV cache also fixes it but decoded ~60% slower).
    """

    def __init__(self, every: int = 16, slack_bytes: int = 1 << 30):
        self.every = every
        self.slack_bytes = slack_bytes
        self.step = 0

    def __call__(self, input_ids: Tensor, scores: FloatTensor) -> FloatTensor:
        self.step += 1
        if self.step % self.every == 0 and torch.cuda.is_available():
            if torch.cuda.memory_reserved() - torch.cuda.memory_allocated() > self.slack_bytes:
                torch.cuda.empty_cache()
        return scores

def get_logits_processor(tokenizer: Tokenizer, eos: int, tokens_per_skin: int, start_tokens):
    processor = VocabSwitchingLogitsProcessor(
        tokenizer=tokenizer,
        switch_token_id=tokenizer.eos,
        eos_token_id=eos,
        tokens_per_skin=tokens_per_skin,
        init=start_tokens,
    )
    return LogitsProcessorList([processor, CudaCacheTrimProcessor()])

@torch.no_grad()
def decode(
    cond: Tensor,
    cond_latents: Tensor,
    inputs_ids: Tensor,
    tokenizer: Tokenizer,
    tokens_per_skin: int,
    vae: SkinVAEModel,
    encode_repeat: int=1,
) -> Dict:
    """
    inputs_ids: (seq_len)

    cond: (N, c)

    cond_latents: (tokens_skin_cond, dim)
    """
    assert cond.dim() == 2, 'do not support batch'
    assert cond_latents.dim() == 2, 'do not support batch'
    
    where_eos = torch.where(inputs_ids == tokenizer.eos)
    if where_eos[0].shape[0] == 0:
        raise ValueError("No EOS token found in inputs_ids")
    where_eos = where_eos[0][:1]
    skeleton_tokens = inputs_ids[:where_eos+1]
    skeleton_tokens = np.array(skeleton_tokens.detach().cpu().numpy())
    detokenize_output = tokenizer.detokenize(ids=skeleton_tokens)
    J = detokenize_output.joints.shape[0]
    
    skin_tokens = inputs_ids[where_eos+1:where_eos+1+J*tokens_per_skin]
    if skin_tokens.shape != (J*(tokens_per_skin),):
        return {
            'skin_pred': None,
            'detokenize_output': detokenize_output,
        }
    cond = cond.unsqueeze(0)
    cond_latents = cond_latents.unsqueeze(0)
    skin = []
    g = tokens_per_skin * encode_repeat
    for s in range(0, J*tokens_per_skin, g):
        t = min(s+g, J*tokens_per_skin)
        indices = skin_tokens[s:t].unsqueeze(0) - tokenizer.vocab_size
        # expect: (b, tokens_per_skin, dim)
        b = (t-s)//tokens_per_skin
        z = vae.model.FSQ.indices_to_codes(indices).reshape(b, tokens_per_skin, -1)
        # (b, n, 1)
        logits = vae.decode(z=z, sampled_cond=cond.repeat(b, 1, 1), cond_tokens=cond_latents.repeat(b, 1, 1))
        skin_pred = logits.reshape(b, logits.shape[1]).permute(1, 0)
        skin.append(skin_pred)
    skin = torch.concat(skin, dim=1).float()
    return {
        'skin_pred': skin,
        'detokenize_output': detokenize_output,
    }

@torch.no_grad()
def decode_multi(
    cond: Tensor,
    cond_latents: Tensor,
    inputs_ids: List[Tensor],
    tokenizer: Tokenizer,
    tokens_per_skin: int,
    vae: SkinVAEModel,
    is_numpy: bool=True,
    encode_repeat: int=1,
) -> List[Dict]:
    """
    inputs_ids: List[(seq_len)]

    cond: (N, c)

    cond_latents: (tokens_skin_cond, dim)
    """
    assert cond.dim() == 2, 'do not support batch'
    assert cond_latents.dim() == 2, 'do not support batch'
    
    B = len(inputs_ids)
    res = [{'skin_pred': None, 'detokenize_output': None} for _ in range(B)]
    device = cond.device
    batch_mapping = []
    skin_tokens_list = []
    oks = []
    oks_J = []
    for i in range(B):
        where_eos = torch.where(inputs_ids[i] == tokenizer.eos)
        if where_eos[0].shape[0] == 0:
            print(f"decode_multi: {i} has bad skeleton")
            continue
        where_eos = where_eos[0][:1]
        skeleton_tokens = inputs_ids[i][:where_eos+1]
        skeleton_tokens = np.array(skeleton_tokens.detach().cpu().numpy())
        try:
            detokenize_output = tokenizer.detokenize(ids=skeleton_tokens)
        except Exception as e:
            print(f"decode_multi: error while decoding skeleton: {str(e)}")
            continue
        J = detokenize_output.joints.shape[0]
        res[i]['detokenize_output'] = detokenize_output # type: ignore
        skin_tokens = inputs_ids[i][where_eos+1:where_eos+1+J*tokens_per_skin]
        if skin_tokens.shape != (J*(tokens_per_skin),):
            print(f"decode_multi: {i} has bad skin")
            continue
        batch_mapping.append(torch.full((J,), i, device=device, dtype=torch.long))
        skin_tokens_list.append(skin_tokens)
        oks.append(i)
        oks_J.append(J)
    if len(batch_mapping) == 0:
        return res
    batch_mapping = torch.cat(batch_mapping, dim=0)
    # (1, sum_J*tokens_per_skin)
    skin_tokens = torch.cat(skin_tokens_list, dim=0).unsqueeze(0)
    cond = cond.unsqueeze(0)
    cond_latents = cond_latents.unsqueeze(0)
    skin_list = []
    g = tokens_per_skin * encode_repeat
    sum_J = batch_mapping.shape[0]
    for s in range(0, sum_J*tokens_per_skin, g):
        t = min(s+g, sum_J*tokens_per_skin)
        # (1, m*tokens_per_skin)
        indices = skin_tokens[:, s:t] - tokenizer.vocab_size
        # expect: (m, tokens_per_skin, dim)
        m = (t-s)//tokens_per_skin
        z = vae.model.FSQ.indices_to_codes(indices).reshape(m, tokens_per_skin, -1)
        # (m, n, 1)
        logits = vae.decode(z=z, sampled_cond=cond.repeat(m, 1, 1), cond_tokens=cond_latents.repeat(m, 1, 1))
        skin_pred = logits.reshape(m, logits.shape[1]).permute(1, 0)
        skin_list.append(skin_pred)
    skin = torch.concat(skin_list, dim=1).float()
    for (i, id) in enumerate(oks):
        skin_pred = skin[:, batch_mapping==id].reshape(-1, oks_J[i])
        res[id]['skin_pred'] = skin_pred.detach().cpu().numpy() if is_numpy else skin_pred
    return res