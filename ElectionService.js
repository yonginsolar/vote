import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// 1. Supabase 클라이언트 초기화 (설정값은 본인 프로젝트 키로 교체 필요)
// 보안상 키는 환경변수로 관리하는 게 좋지만, 프론트엔드 MVP에서는 노출되어도 RLS로 방어합니다.
const SUPABASE_URL = 'https://ifdqlwxgqgsvnawmhlfc.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmZHFsd3hncWdzdm5hd21obGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxODQ3NDIsImV4cCI6MjA4Mjc2MDc0Mn0.UKUvMOl58KuDH24seC3oSgla7mK5lr-vXjqtpalnl6k';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * ElectionService: 선거 관련 모든 데이터 로직을 담당하는 클래스
 * 역할: UI 코드에서 복잡한 DB 쿼리를 분리함.
 */
export class ElectionService {
    
    constructor() {
        this.currentUser = null; // auth.users 정보
        this.memberProfile = null; // coop_members 정보
        this.voterInfo = null; // election_voters 정보 (선거구 포함)
    }

    /**
     * [1] 시스템 초기화 및 사용자 로드
     * - 로그인 상태 확인 및 조합원 정보 로드
     */
    async initialize() {
        const { data: { user }, error } = await supabase.auth.getUser();
        
        if (error || !user) {
            console.log('비로그인 상태입니다.');
            return null;
        }

        this.currentUser = user;
        
        // 1-2. 조합원 상세 정보(이름 등) 가져오기
        // auth.users의 id와 coop_members의 id가 같다고 가정
        const { data: profile, error: profileError } = await supabase
            .from('coop_members')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError) {
            console.error('조합원 정보 로드 실패:', profileError);
            throw new Error('조합원 정보를 찾을 수 없습니다.');
        }

        this.memberProfile = profile;
        return this.memberProfile;
    }

    /**
     * [2] 현재 진행 중인 선거 정보 가져오기
     * - status가 OPEN인 선거 조회
     */
    async getActiveElection() {
        const { data, error } = await supabase
            .from('elections')
            .select('*')
            .eq('status', 'OPEN')
            .single(); // 하나만 가져옴

        if (error) return null;
        return data;
    }

    /**
     * [3] 나의 선거구 및 후보자 정보 가져오기 (핵심 로직)
     * - 내 선거구 확인 -> 해당 선거구 설정(투표타입) -> 승인된 후보자 목록 로드
     */
    async getMyBallotInfo(electionId) {
        if (!this.memberProfile) await this.initialize();

        // 3-1. 내가 이 선거에서 어느 선거구인지 확인 (election_voters)
        const { data: voterData, error: voterError } = await supabase
            .from('election_voters')
            .select(`
                district_id,
                districts ( name, vote_type, quota )
            `)
            .eq('election_id', electionId)
            .eq('member_uuid', this.memberProfile.id)
            .single();

        if (voterError || !voterData) {
            throw new Error('귀하는 이번 선거의 선거구에 배정되지 않았습니다. 관리자에게 문의하세요.');
        }

        const districtInfo = voterData.districts;
        const districtId = voterData.district_id;
        this.voterInfo = { ...voterData, ...districtInfo }; // 정보 합치기

        // 3-2. 해당 선거구의 후보자 목록 가져오기 (승인된 사람만)
        let candidates = [];
        if (districtInfo.vote_type === 'CANDIDATE') {
            const { data: candData, error: candError } = await supabase
                .from('candidates')
                .select('*')
                .eq('election_id', electionId)
                .eq('district_id', districtId)
                .eq('status', 'APPROVED') // 승인된 후보만
                .order('name', { ascending: true }); // 이름순 정렬
            
            if (candError) throw new Error('후보자 목록 로드 실패');
            candidates = candData;
        }

        // 3-3. 이미 투표했는지 확인
        const { data: logData } = await supabase
            .from('vote_logs')
            .select('id')
            .eq('election_id', electionId)
            .eq('member_uuid', this.memberProfile.id)
            .maybeSingle();

        return {
            district: districtInfo,
            district_id: districtId,
            candidates: candidates,
            hasVoted: !!logData // 투표 기록이 있으면 true
        };
    }

    /**
     * [4] 투표 제출 (RPC 호출)
     */
    async submitVote({ electionId, districtId, round, candidateId, choice }) {
        // RPC 함수 호출
        const { data, error } = await supabase.rpc('submit_vote', {
            p_election_id: electionId,
            p_district_id: districtId,
            p_round: round,
            p_candidate_id: candidateId || null,
            p_choice: choice || null
        });

        if (error) {
            console.error('투표 제출 에러:', error);
            throw new Error(error.message); // "이미 투표했습니다" 등이 여기서 걸림
        }

        return true;
    }
}

/* ElectionService.js 클래스 내부에 추가 */

// [추가] 후보자 등록 신청
async applyCandidate(formData) {
    // 1. 이미지 업로드 처리
    const file = formData.photoFile;
    const fileExt = file.name.split('.').pop();
    const fileName = `${this.memberProfile.id}_${Date.now()}.${fileExt}`; // 파일명 중복 방지
    const filePath = `${formData.electionId}/${fileName}`;

    const { error: uploadError } = await supabase.storage
        .from('candidates')
        .upload(filePath, file);

    if (uploadError) throw new Error('사진 업로드 실패: ' + uploadError.message);

    // 2. 공개 URL 가져오기
    const { data: { publicUrl } } = supabase.storage
        .from('candidates')
        .getPublicUrl(filePath);

    // 3. DB Insert (초기 상태는 PENDING)
    const { error: dbError } = await supabase
        .from('candidates')
        .insert({
            election_id: formData.electionId,
            district_id: formData.districtId,
            member_uuid: this.memberProfile.id,
            name: formData.name,
            manifesto: formData.manifesto,
            photo_url: publicUrl,
            status: 'PENDING'
        });

    if (dbError) throw new Error('후보 등록 실패: ' + dbError.message);
}
