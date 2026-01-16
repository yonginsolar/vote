import { supabase } from './ElectionService.js'; // 기존 설정 재사용

export class AdminService {
    
    // [보안] 관리자 여부 확인 (화면 진입 시 체크용)
    // 실제 보안은 DB RLS가 막아주지만, UX를 위해 1차 체크
// [수정] 관리자 여부 확인 (DB의 is_admin 함수를 직접 호출하여 정확도 100% 확보)
    async isAdmin() {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return false;

        // DB에 정의된 is_admin() 함수 실행
        const { data, error } = await supabase.rpc('is_admin');
        
        // 에러 없고, 결과가 true면 관리자임
        return !error && data; 
    }

    // 1. 선거 정보 및 현재 상태 가져오기
    async getElectionInfo() {
        // 가장 최근 선거 하나만 가져옴
        const { data, error } = await supabase
            .from('elections')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
            
        if (error) throw error;
        return data;
    }

    // 2. 선거 상태 변경 (핵심 기능)
    // status: 'OPEN', 'CLOSED', 'PUBLISHED', 'PAUSED'
    async updateStatus(electionId, newStatus) {
        const { error } = await supabase
            .from('elections')
            .update({ status: newStatus })
            .eq('id', electionId);
            
        if (error) throw new Error('상태 변경 실패: ' + error.message);
    }

    // 3. 승인 대기중인 후보자 목록 가져오기
    async getPendingCandidates(electionId) {
        const { data, error } = await supabase
            .from('candidates')
            .select(`*, districts(name)`) // 선거구 이름도 같이
            .eq('election_id', electionId)
            .eq('status', 'PENDING');

        if (error) throw error;
        return data;
    }

    // 4. 후보자 승인/반려 처리
    async reviewCandidate(candidateId, decision) {
        // decision: 'APPROVED' or 'REJECTED'
        const { error } = await supabase
            .from('candidates')
            .update({ status: decision })
            .eq('id', candidateId);
            
        if (error) throw error;
    }

    // 5. [모니터링] 실시간 투표율 집계
    // RLS 때문에 일반 유저는 못 쓰는 쿼리
    async getTurnoutStats(electionId) {
        // 전체 유권자 수 (명부 기준)
        const { count: totalVoters } = await supabase
            .from('election_voters')
            .select('*', { count: 'exact', head: true })
            .eq('election_id', electionId);

        // 투표 참여자 수 (로그 기준)
        const { count: currentVotes } = await supabase
            .from('vote_logs')
            .select('*', { count: 'exact', head: true })
            .eq('election_id', electionId);

        return {
            total: totalVoters || 0,
            current: currentVotes || 0,
            percent: totalVoters ? ((currentVotes / totalVoters) * 100).toFixed(1) : 0
        };
    }

    // 6. [개표] 결과 가져오기 (관리자 전용)
    async getResults(electionId) {
        // 실제로는 DB RPC로 집계하는 게 빠르지만, MVP에서는 JS로 계산
        // 1. 모든 투표용지 가져오기
        const { data: ballots, error } = await supabase
            .from('ballots')
            .select(`
                district_id,
                candidate_id,
                choice,
                districts(name, vote_type),
                candidates(name)
            `)
            .eq('election_id', electionId);

        if (error) throw error;
        return ballots; // 화면에서 가공해서 그림
    }
    // [추가] 모든 선거 이력 가져오기 (최신순 정렬)
    async getAllElections() {
        const { data, error } = await supabase
            .from('elections')
            .select('*')
            .order('created_at', { ascending: false }); // 최신 선거가 위로

        if (error) {
            console.error('선거 목록 로드 실패:', error);
            return [];
        }
        return data;
    }
}
