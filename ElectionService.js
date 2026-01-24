// 변경된 Import URL: esm.sh를 사용하여 Named Export 호환성 문제 해결
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 1. Supabase 클라이언트 초기화
const SUPABASE_URL = 'https://ifdqlwxgqgsvnawmhlfc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmZHFsd3hncWdzdm5hd21obGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxODQ3NDIsImV4cCI6MjA4Mjc2MDc0Mn0.UKUvMOl58KuDH24seC3oSgla7mK5lr-vXjqtpalnl6k';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * ElectionService: 선거 관련 모든 데이터 로직을 담당하는 클래스
 */
export class ElectionService {
    
    constructor() {
        this.currentUser = null; // auth.users 정보
        this.memberProfile = null; // coop_members 정보
        this.voterInfo = null; // election_voters 정보 (선거구 포함)
    }

    /**
     * [1] 시스템 초기화 및 사용자 로드
     */
    async initialize() {
        const { data: { user }, error } = await supabase.auth.getUser();
        
        if (error || !user) {
            console.log('비로그인 상태입니다.');
            return null;
        }

        this.currentUser = user;
        
        // 1-2. 조합원 상세 정보 가져오기
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
     * [2] 현재 활성화된 선거 정보 가져오기 (수정됨)
     * - 수정 사유: 후보 등록 기간(NOMINATION)인 선거도 조회되어야 함
     */
    async getActiveElection() {
        const { data, error } = await supabase
            .from('elections')
            .select('*')
            // 기존: .eq('status', 'OPEN') 
            // 변경: 'OPEN' 이거나 'NOMINATION' 상태인 선거 조회
            .in('status', ['OPEN', 'NOMINATION']) 
            .maybeSingle(); // 결과가 없으면 에러 대신 null 반환 (안전장치)

        if (error) {
            console.error('선거 정보 조회 실패:', error);
            return null;
        }
        return data;
    }

    /**
     * [3] 나의 선거구 및 후보자 정보 가져오기
     */
    async getMyBallotInfo(electionId) {
        if (!this.memberProfile) await this.initialize();

        // 3-1. 내가 이 선거에서 어느 선거구인지 확인
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
        this.voterInfo = { ...voterData, ...districtInfo };

        // 3-2. 해당 선거구의 후보자 목록 가져오기
        let candidates = [];
        if (districtInfo.vote_type === 'CANDIDATE') {
            const { data: candData, error: candError } = await supabase
                .from('candidates')
                .select('*')
                .eq('election_id', electionId)
                .eq('district_id', districtId)
                .eq('status', 'APPROVED')
                .order('name', { ascending: true });
            
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
            hasVoted: !!logData
        };
    }

    /**
     * [4] 투표 제출 (RPC 호출)
     */
    async submitVote({ electionId, districtId, round, candidateId, choice }) {
        const { data, error } = await supabase.rpc('submit_vote', {
            p_election_id: electionId,
            p_district_id: districtId,
            p_round: round,
            p_candidate_id: candidateId || null,
            p_choice: choice || null
        });

        if (error) {
            console.error('투표 제출 에러:', error);
            throw new Error(error.message);
        }

        return true;
    }

    /**
     * [5] 후보자 등록 신청 (여기가 수정된 위치입니다)
     * - 반드시 클래스 내부(닫는 괄호 전)에 있어야 합니다.
     */
    async applyCandidate(formData) {
        // 1. 이미지 업로드 처리
        const file = formData.photoFile;
        const fileExt = file.name.split('.').pop();
        const fileName = `${this.memberProfile.id}_${Date.now()}.${fileExt}`;
        const filePath = `${formData.electionId}/${fileName}`;

        const { error: uploadError } = await supabase.storage
            .from('candidates')
            .upload(filePath, file);

        if (uploadError) throw new Error('사진 업로드 실패: ' + uploadError.message);

        // 2. 공개 URL 가져오기
        const { data: { publicUrl } } = supabase.storage
            .from('candidates')
            .getPublicUrl(filePath);

        // 3. DB Insert
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

} // End of ElectionService class
